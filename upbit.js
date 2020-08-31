const EventEmitter = require('events');
const ccxt = require('ccxt');
const conf = require("./conf");
const mutex = require("./mutex");

let events = new EventEmitter();
let dest_balances = null;

let last_trade_id = null;

let assocOrderIdsByHashes = {};
let assocOrders = {};
let assocCancelsUnderWay = {};
let index = 0;


let upbit = new ccxt.upbit({
	apiKey: conf.destApiKey,
	secret: conf.destApiSecret,
	urls: {
		api: {
			public: conf.upbit_api_url,
			private: conf.upbit_api_url,
		}
	}
});

function getHash(pair, side, size, price) {
	index++;
	return pair + '-' + side + '-' + size + '-' + price + '-' + index;
}

function getHashByOrderId(id) {
	for (let hash in assocOrderIdsByHashes)
		if (assocOrderIdsByHashes[hash] === id)
			return hash;
	return null;
}

function createAndSendOrder(pair, side, size, price) {
	let hash = getHash(pair, side, size, price);
	createLimitTx(pair, side, size, price, hash);
	return hash;
}

async function createLimitTx(pair, side, size, price, hash) {
	assocOrderIdsByHashes[hash] = null; // null means that order creation is under way
	await waitUntilMyMatchingOrdersRemoved(side, price);
	await doCreateLimitTx(pair, side, size, price, hash);
}

async function doCreateLimitTx(pair, side, size, price, hash, attempt) {
	mutex.lock("order", async function(unlock){

		attempt = attempt || 0;
		if (assocOrderIdsByHashes[hash] === null) {
			try {
				console.log('will attempt to create order ' + hash);
				let order = (side === 'BUY')
					? await upbit.createLimitBuyOrder(pair, size, price)
					: await upbit.createLimitSellOrder(pair, size, price);
				console.log('---- limit_resp', hash, order);
				assocOrderIdsByHashes[hash] = order.id;
				assocOrders[order.id] = { side, size, price };
			}
			catch (e) {
				console.log('---- creating dest order ' + hash + ' failed', e instanceof ccxt.InsufficientFunds, "cancels under way:", Object.keys(assocCancelsUnderWay).length, e);
				if (attempt > 10)
					throw Error("too many retries while creating order " + hash);
				// retry
				attempt++;
				setTimeout(unlock, 2); // ccxt uses the time in millisecond as nonce, we delay unlocking to avoid nonce reusing
				return setTimeout(() => doCreateLimitTx(pair, side, size, price, hash, attempt), 100);
			//	assocOrderIdsByHashes[hash] = 0;
			//	throw e;
			}
			setTimeout(unlock, 2); // ccxt uses the time in millisecond as nonce, we delay unlocking to avoid nonce reusing
		} else
			unlock();
		events.emit(hash, assocOrderIdsByHashes[hash]);
	});
}

async function waitUntilMyMatchingOrdersRemoved(side, price, attempt) {
	attempt = attempt || 0;
	if (!wouldSelfTrade(side, price)) {
		if (attempt > 0)
			console.log("my matching orders are finally removed, will submit " + side + " at " + price);
		return;
	}
	if (attempt > 20)
		throw Error("too long waiting for my matching orders to be removed before submitting " + side + " at " + price);
	console.log("will wait until my matching orders are removed before submitting " + side + " at " + price);
	await wait(100);
	await waitUntilMyMatchingOrdersRemoved(side, price, attempt + 1);
}

function wouldSelfTrade(side, price) {
	if (side === 'BUY')
		for (let id in assocOrders) {
			let order = assocOrders[id];
			if (order.side === 'SELL' && order.price <= price)
				return true;
		}
	else
		for (let id in assocOrders) {
			let order = assocOrders[id];
			if (order.side === 'BUY' && order.price >= price)
				return true;
		}
	return false;
}

function createAndSendCancel(hash) {
	console.log('will cancel order ' + hash);
	let id = assocOrderIdsByHashes[hash];
	if (id === undefined)
		return console.log("trying to cancel unknown order " + hash);
	delete assocOrderIdsByHashes[hash];
	if (id === null) { // response from order creation not received yet
		console.log('response from order creation of ' + hash + ' not received yet, will wait');
		return events.once(hash, id => {
			console.log('waiting for creation of order ' + hash + ' done, id = ' + id);
			if (id)
				createAndSendCancel(hash);
		});
	}
	if (id === 0)
		return console.log("will not cancel order " + hash + " whose creation failed");
	cancelOrder(id, hash);
}

async function cancelOrder(id, hash) {
	assocCancelsUnderWay[id] = true;
	mutex.lock("order", async function(unlock){

		try {
			let cancel_resp = await upbit.cancelOrder(id, 'GBYTE/BTC');
			console.log('---- cancel_resp', id, hash, cancel_resp);
		}
		catch (e) {
			let bTransient = (e instanceof ccxt.ExchangeNotAvailable || e instanceof ccxt.RequestTimeout || e instanceof ccxt.NetworkError);
			console.log('---- cancelling dest order ' + id + ' (' + hash + ') failed', bTransient, e);
			if (bTransient){
				setTimeout(unlock, 2);
				return cancelOrder(id, hash);
			}
		}
		delete assocOrders[id];
		delete assocCancelsUnderWay[id];
		setTimeout(unlock, 2);
	});
}

async function getBalances() {
	let unlock = await mutex.lock('dest_balances');
	unlock();
	return dest_balances;
}

async function updateBalances() {
	let unlock = await mutex.lock('dest_balances');
	try {
		dest_balances = await upbit.fetchBalance();
		console.log('---- fetched balances', dest_balances);
	}
	catch (e) {
		console.log("error from fetchBalance: " + e)
	}
	unlock();
}

async function getOpenOrders() {
	let orders = await upbit.fetchOpenOrders('GBYTE/BTC');
	console.log('all orders', orders);
	return orders.map(order => order.id);
}

async function cancelAllOpenOrders() {
	while (true) {
		let ids = await getOpenOrders();
		if (ids.length === 0)
			break;
		console.log("will cancel " + ids.length + " dest orders");
		for (let id of ids)
			await cancelOrder(id);
	}
}

async function wait(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

async function getOrderInfo(order_id, attempt) {
	attempt = attempt || 0;
	try {
		return await upbit.fetchOrder(order_id);
	}
	catch (e) {
		if (attempt > 10)
			throw Error("too many failures while trying to get order " + order_id + ": " + e);
		console.log("getting order " + order_id + " failed, will retry later", e);
		await wait(100);
		return await getOrderInfo(order_id, attempt + 1);
	}
}

async function getMyTrades() {
	let trades = await upbit.fetchMyTrades('GBYTE/BTC');
	console.log('all my trades', trades);
	return trades;
}

async function setLastTradeId() {
	let trades = await getMyTrades();
	if (trades.length > 0)
		last_trade_id = trades[0].id;
}

async function getNewMyTrades() {
	let trades = await getMyTrades();
	let my_trades = [];
	for (let trade of trades) {
		if (last_trade_id && trade.id === last_trade_id)
			break;
		my_trades.push(trade);
	}
	my_trades.reverse(); // from old to new
	console.log("my dest trades", JSON.stringify(my_trades, null, '\t'));
	return my_trades;
}

async function getAmountOfMyNewTrades() {
	let my_trades = await getNewMyTrades();
	let amount = 0;
	for (let trade of my_trades) {
		let order_id = trade.order;
		let order = assocOrders[order_id];
		if (!order)
			throw Error("unknown order filled: " + order_id);
		if (order.side === 'BUY')
			amount += trade.amount;
		else
			amount -= trade.amount;
	}
	return amount;
}

function getOrderIdsByPrices(prices) {
	prices = prices.map(parseFloat);
	console.log('getOrderIdsByPrices', prices);
	let order_ids = [];
	for (let id in assocOrders) {
		let order = assocOrders[id];
		if (prices.find(price => Math.abs(price - order.price) <= 1e-8 || order.side === 'SELL' && order.price <= price || order.side === 'BUY' && order.price >= price))
			order_ids.push(id);
	}
	console.log('--- affected orders', order_ids);
	return order_ids;
}

async function getFilledAmountByPrices(prices) {
	let order_ids = getOrderIdsByPrices(prices);
	if (order_ids.length === 0)
		return 0;
	return await getFilledAmount(order_ids);
}

function delay(ms){
	return new Promise(function(resolve){
		setTimeout(resolve, ms);
	});
}

async function getFilledAmount(order_ids) {
	let amount = 0;
	await delay(100);
	for (let order_id of order_ids) {
		let dest_order = await getOrderInfo(order_id);
		console.log('--- affected order', dest_order);
		console.log('order', order_id, dest_order.side, dest_order.price, getHashByOrderId(order_id), 'filled', dest_order.filled);
		let order = assocOrders[order_id];
		console.log('our order', order);
		let already_filled = (order && order.filled) ? order.filled : 0;
		let newly_filled = dest_order.filled - already_filled;
		console.log(' === newly filled', newly_filled, '\n')
		if (dest_order.side === 'buy')
			amount += newly_filled;
		else
			amount -= newly_filled;
		if (order)
			order.filled = dest_order.filled;
	}
	return amount;
}

async function start() {
	await updateBalances();
//	await setLastTradeId();
	setInterval(updateBalances, 60 * 1000);
}

exports.start = start;
exports.getBalances = getBalances;
exports.updateBalances = updateBalances;
exports.createAndSendOrder = createAndSendOrder;
exports.createAndSendCancel = createAndSendCancel;
exports.getOpenOrders = getOpenOrders;
exports.cancelAllOpenOrders = cancelAllOpenOrders;
exports.getNewMyTrades = getNewMyTrades;
exports.getAmountOfMyNewTrades = getAmountOfMyNewTrades;
exports.getFilledAmountByPrices = getFilledAmountByPrices;
