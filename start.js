/*jslint node: true */
'use strict';
const ccxws = require("ccxws");
const conf = require("./conf");
const mutex = require("./mutex");
const source = require("./source");
const upbit = require("./upbit");


let assocSourceBids = {};
let assocSourceAsks = {};
let assocDestOrdersBySourcePrice = {};
let bExiting = false;

async function cancelAllTrackedDestOrdersBeforeExiting() {
	console.log("will cancel all tracked dest orders before exiting");
	if (bExiting)
		return;
	bExiting = true;
	await cancelAllTrackedDestOrders();
}

async function cancelAllTrackedDestOrders() {
	console.log("will cancel " + Object.keys(assocDestOrdersBySourcePrice).length + " tracked dest orders");
	for (let source_price in assocDestOrdersBySourcePrice) {
		let dest_order = assocDestOrdersBySourcePrice[source_price];
		console.log("cancelling order " + dest_order.hash);
		upbit.createAndSendCancel(dest_order.hash);
	}
	await wait(1000);
}

async function cancelAllDestOrders() {
	console.log("will cancel all dest orders");
	await upbit.cancelAllOpenOrders();
	await wait(1000);
}

async function wait(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

async function createOrReplaceDestOrder(side, size, source_price) {
	let dest_order = assocDestOrdersBySourcePrice[source_price];
	if (dest_order) {
		if (dest_order.size === 0)
			throw Error("0-sized dest order " + dest_order.hash);
		if (dest_order.size === size) // unchanged
			return console.log("order " + size + " GB at source price " + source_price + " already exists");
		// size changed, cancel the old order first
		console.log("will cancel previous " + side + " order at source price " + source_price);
		delete assocDestOrdersBySourcePrice[source_price];
		await upbit.createAndSendCancel(dest_order.hash); // order cancelled or modified
	}
	let sign = (side === 'BUY') ? -1 : 1;
	let dest_price = parseFloat(source_price) * (1 + sign * conf.MARKUP / 100);
	console.log("will place " + side + " order for " + size + " GB at " + dest_price + " corresponding to source price " + source_price);
	let hash = await upbit.createAndSendOrder(conf.dest_pair, side, size, dest_price);
	console.log("sent order " + hash);
	assocDestOrdersBySourcePrice[source_price] = { hash, size };
}

async function createDestOrders(arrNewOrders) {
	for (let i = 0; i < arrNewOrders.length; i++){
		let { size, source_price, side } = arrNewOrders[i];
		await createOrReplaceDestOrder(side, size, source_price);
	}
}

// returns true if a previous order not exists or is different and was cancelled
async function cancelPreviousDestOrderIfChanged(side, size, source_price) {
	let dest_order = assocDestOrdersBySourcePrice[source_price];
	if (!dest_order)
		return true;
	if (dest_order.size === 0)
		throw Error("0-sized dest order " + dest_order.hash);
	if (dest_order.size === size) { // unchanged
		console.log("order " + size + " GB at source price " + source_price + " already exists");
		return false;
	}
	// size changed, cancel the old order first
	console.log("will cancel previous " + side + " order at source price " + source_price);
	delete assocDestOrdersBySourcePrice[source_price];
	await upbit.createAndSendCancel(dest_order.hash); // order cancelled or modified
	return true;
}

async function cancelDestOrder(source_price) {
	let dest_order = assocDestOrdersBySourcePrice[source_price];
	if (dest_order) {
		delete assocDestOrdersBySourcePrice[source_price];
		console.log("will cancel order " + dest_order.hash + " at source price " + source_price);
		await upbit.createAndSendCancel(dest_order.hash);
	}
//	else
//		console.log("no dest order at source price " + source_price);
}


async function updateDestBids(bids) {
	let unlock = await mutex.lock('bids');
	let dest_balances = await upbit.getBalances();
	let source_balances = await source.getBalances();
//	console.log('dest balances', dest_balances);
	let dest_quote_balance_available = (dest_balances.total[conf.quote_currency] || 0) - conf.MIN_QUOTE_BALANCE;
	let source_base_balance_available = (source_balances.free.GBYTE || 0) - conf.MIN_BASE_BALANCE;
	let arrNewOrders = [];
	let bDepleted = (dest_quote_balance_available <= 0 || source_base_balance_available <= 0);
	for (let i = 0; i < bids.length; i++){
		let bid = bids[i];
		let source_price = bid.price;
		if (bDepleted) { // cancel all remaining orders to make sure we have enough free funds for other orders
			await cancelDestOrder(source_price);
			continue;
		}
		let size = parseFloat(bid.size);
		if (size > source_base_balance_available) {
			bDepleted = true;
			console.log("bid #" + i + ": " + size + " GB at " + source_price + " but have only " + source_base_balance_available + " GB available on source");
			size = source_base_balance_available;
		}
		let dest_price = parseFloat(source_price) * (1 - conf.MARKUP / 100);
		let dest_quote_amount_required = size * dest_price;
		if (dest_quote_amount_required > dest_quote_balance_available) {
			bDepleted = true;
			console.log("bid #" + i + ": " + size + " GB at " + source_price + " requires " + dest_quote_amount_required + " BTC on dest but have only " + dest_quote_balance_available + " BTC available on dest");
			dest_quote_amount_required = dest_quote_balance_available;
			size = dest_quote_amount_required / dest_price;
		}
		// cancel the old order first, otherwise if it was downsized and made up more room for other orders, we might hit insufficient balance error when we try to place them
		let bNeedNewOrder = await cancelPreviousDestOrderIfChanged('BUY', size, source_price);
		if (bNeedNewOrder && size >= conf.MIN_DEST_ORDER_SIZE)
			arrNewOrders.push({ size, source_price, side: 'BUY' });
		if (size >= conf.MIN_DEST_ORDER_SIZE) {
			source_base_balance_available -= size;
			dest_quote_balance_available -= dest_quote_amount_required;
		}
		else
			console.log("skipping bid " + size + " GB at " + source_price + " as it is too small");
	}
	unlock();
	return arrNewOrders;
}

async function updateDestAsks(asks) {
	let unlock = await mutex.lock('asks');
	let dest_balances = await upbit.getBalances();
	let source_balances = await source.getBalances();
	//console.log('dest balances', dest_balances);
	let dest_base_balance_available = (dest_balances.total.GBYTE || 0) - conf.MIN_BASE_BALANCE;
	let source_quote_balance_available = (source_balances.free.BTC || 0) - conf.MIN_QUOTE_BALANCE;
	let arrNewOrders = [];
	let bDepleted = (dest_base_balance_available <=0 || source_quote_balance_available <= 0);
	for (let i = 0; i < asks.length; i++){
		let ask = asks[i];
		let source_price = ask.price;
		if (bDepleted) { // cancel all remaining orders to make sure we have enough free funds for other orders
			await cancelDestOrder(source_price);
			continue;
		}
		let size = parseFloat(ask.size);
		if (size > dest_base_balance_available) {
			bDepleted = true;
			console.log("ask #" + i + ": " + size + " GB at " + source_price + " but have only " + dest_base_balance_available + " GB available on dest");
			size = dest_base_balance_available;
		}
		let source_quote_amount_required = size * parseFloat(source_price);
		if (source_quote_amount_required > source_quote_balance_available) {
			bDepleted = true;
			console.log("ask #" + i + ": " + size + " GB at " + source_price + " requires " + source_quote_amount_required + " BTC on source but have only " + source_quote_balance_available + " BTC available on source");
			source_quote_amount_required = source_quote_balance_available;
			size = source_quote_amount_required / parseFloat(source_price);
		}
		// cancel the old order first, otherwise if it was downsized and made up more room for other orders, we might hit insufficient balance error when we try to place them
		let bNeedNewOrder = await cancelPreviousDestOrderIfChanged('SELL', size, source_price);
		if (bNeedNewOrder && size >= conf.MIN_DEST_ORDER_SIZE)
			arrNewOrders.push({ size, source_price, side: 'SELL' });
		if (size >= conf.MIN_DEST_ORDER_SIZE) {
			source_quote_balance_available -= source_quote_amount_required;
			dest_base_balance_available -= size;
		}
		else
			console.log("skipping ask " + size + " GB at " + source_price + " as it is too small");
	}
	unlock();
	return arrNewOrders;
}

async function scanAndUpdateDestBids() {
	let bids = [];
	for (let price in assocSourceBids)
		bids.push({ price, size: assocSourceBids[price] });
	bids.sort((a, b) => parseFloat(b.price) - parseFloat(a.price));
	console.log("will update bids");
	return await updateDestBids(bids);
}

async function scanAndUpdateDestAsks() {
	let asks = [];
	for (let price in assocSourceAsks)
		asks.push({ price, size: assocSourceAsks[price] });
	asks.sort((a, b) => parseFloat(a.price) - parseFloat(b.price));
	console.log("will update asks");
	return await updateDestAsks(asks);
}

async function onSourceOrderbookSnapshot(snapshot) {
	let unlock = await mutex.lock('update');
	console.log('received snapshot');
	assocSourceBids = {};
	assocSourceAsks = {};
	snapshot.bids.forEach(bid => {
		assocSourceBids[bid.price] = bid.size;
	});
	snapshot.asks.forEach(ask => {
		assocSourceAsks[ask.price] = ask.size;
	});
	// in case a secondary (non-initial) snapshot is received, we need to check if we missed some updates
	for (let source_price in assocDestOrdersBySourcePrice) {
		if (!assocSourceBids[source_price] && !assocSourceAsks[source_price]) {
			console.log("order at " + source_price + " not found in new snapshot from source, will cancel on dest");
			await cancelDestOrder(source_price);
		}
	}
	let arrNewBuyOrders = await updateDestBids(snapshot.bids);
	let arrNewSellOrders = await updateDestAsks(snapshot.asks);
	await createDestOrders(arrNewBuyOrders.concat(arrNewSellOrders));
	unlock();
}

async function onSourceOrderbookUpdate(update) {
	let unlock = await mutex.lock('update');
	let arrNewBuyOrders = [];
	let arrNewSellOrders = [];
	if (update.bids.length > 0) {
		for (let i = 0; i < update.bids.length; i++) {
			let bid = update.bids[i];
			let size = parseFloat(bid.size);
			if (size === 0) {
				console.log("bid at " + bid.price + " removed from source, will cancel on dest");
				delete assocSourceBids[bid.price];
				await cancelDestOrder(bid.price);
			}
			else
				assocSourceBids[bid.price] = bid.size;
		}
		arrNewBuyOrders = await scanAndUpdateDestBids();
	}
	if (update.asks.length > 0) {
		for (let i = 0; i < update.asks.length; i++) {
			let ask = update.asks[i];
			let size = parseFloat(ask.size);
			if (size === 0) {
				console.log("ask at " + ask.price + " removed from source, will cancel on dest");
				delete assocSourceAsks[ask.price];
				await cancelDestOrder(ask.price);
			}
			else
				assocSourceAsks[ask.price] = ask.size;
		}
		arrNewSellOrders = await scanAndUpdateDestAsks();
	}
	// we cancel all removed/updated orders first, then create new ones to avoid overlapping prices and self-trades
	await createDestOrders(arrNewBuyOrders.concat(arrNewSellOrders));
	unlock();
}



function startBittrexWs() {
	const bittrexWS = new ccxws.bittrex();
	// market could be from CCXT or genearted by the user
	const market = {
		id: "GBYTE-BTC", // remote_id used by the exchange
		base: "GBYTE", // standardized base symbol for Bitcoin
		quote: "BTC", // standardized quote symbol for Tether
	};
 
	bittrexWS.on("error", err => console.log('---- error from bittrex socket', err));

	// handle level2 orderbook snapshots
	bittrexWS.on("l2snapshot", onSourceOrderbookSnapshot);
	bittrexWS.on("l2update", onSourceOrderbookUpdate);

	// subscribe to trades
	bittrexWS.subscribeTrades(market);

	// subscribe to level2 orderbook updates
	bittrexWS.subscribeLevel2Updates(market);
}


/**
 * headless wallet is ready
 */
async function start() {
	console.log('---- starting upbit-orderbook-replication');
	await source.start();
	await upbit.start();
	const upbit_ws = new ccxws.Upbit();

	await upbit_ws.subscribeTrades(conf.dest_ws_market);
	await upbit_ws.subscribeTicker(conf.dest_ws_market); // we have to subscribe ticker in order to keep the websocket alive

	upbit_ws.on("trade", async (trade) => {
		if (trade.unix < new Date() - 90000) // we can ignore trade older than the upbit websocket watchdog timeout 
			return console.log('ignore old trade');
		let amount = await upbit.getFilledAmountByPrices([trade.price]);
		if (amount === 0)
			return console.log("my orders not affected or not filled");
		upbit.updateBalances();
		let side = (amount > 0) ? 'BUY' : 'SELL';
		let size = (amount > 0) ? amount : -amount;
		console.log("detected fill of my " + side + " " + size + " GB on dest exchange, will do the opposite on source exchange");
		await source.createMarketTx(side === 'BUY' ? 'SELL' : 'BUY', size);
	});

	upbit_ws.on("error", error => console.log(error));

	await cancelAllDestOrders();

	startBittrexWs();
}

start();


process.on('unhandledRejection', async up => {
	console.log('unhandledRejection event', up);
	await cancelAllTrackedDestOrdersBeforeExiting();
	console.log('unhandledRejection done cancelling orders');
	process.exit(1);
//	throw up;
});
process.on('exit', () => {
	console.log('exit event');
	cancelAllTrackedDestOrdersBeforeExiting();
});
process.on('beforeExit', async () => {
	console.log('beforeExit event');
	await cancelAllTrackedDestOrdersBeforeExiting();
	console.log('beforeExit done cancelling orders');
});
['SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGILL', 'SIGTRAP', 'SIGABRT', 'SIGBUS', 'SIGFPE', 'SIGUSR1', 'SIGSEGV', 'SIGUSR2', 'SIGTERM'].forEach(function (sig) {
    process.on(sig, async () => {
		console.log(sig + ' event');
		await cancelAllTrackedDestOrdersBeforeExiting();
		console.log(sig + ' done cancelling orders');
		process.exit(1);
	});
});