# Upbit orderbook replication bot

This trading bot replicates the orderbook from Bittrex to Upbit for GBYTE/BTC trading pair. It copies all pending buy and sell orders from the source exchange (Bittrex) to the destination exchange (Upbit) while adding a configurable (2% by default) markup. Once an order is filled on Upbit, the bot immediately sends an opposite market order of the same amount to Bittrex. For example, if the bot's sell order for 1 GBYTE is filled on Upbit, it immediately buys 1 GBYTE on Bittrex. Thus, its exposure stays constant while it earns the difference between the buy and sell prices, which is supposed to be equal to the markup, minus exchange fees.

If the source exchange is more liquid than the destination exchange, the bot's activity improves the depth of the orderbook on the destination exchange (Upbit).

This bot and its source code are offered as is, without any guarantees of its correct operation. The bot might lose money because of bugs, unreliable network connections, and other reasons.

## Install
Install node.js 8+, clone the repository, then say
```sh
npm install
```

## Configure

Enable API access on both exchanges and get the corresponding API keys. Your API keys should be with access to trading only, don't enable withdrawals for security reasons.

Copy `.env.sample` file to `.env` and fill out your API credentials for both source (Bittrex) and destination (Upbit) exchanges.

You can operate from Upbit Indonesia or Upbit Korea since they share the same GB/BTC orderbook, however their API endpoints are not the same. If your account is at Upbit Indonesia, add `indonesia=1` to the `.env` file.

## Prepare

Deposit BTC and GBYTE to both exchanges. 

The total amount of orders the bot can create on the destination exchange is capped by your balances on the exchanges. For example, the total amount of GBYTE you can have in asks on the destination exchange is capped by both your GBYTE balance on the destination exchange and your BTC balance on the source exchange (as you will use BTC to buy GBYTE on the source exchange when GBYTE is sold on the destination exchange).

## Run
```sh
node start.js
```
It is recommended to run the bot using [pm2](https://pm2.keymetrics.io/) to enable automatic restarts. Install pm2 globally:
```sh
npm install -g pm2
```
Run:
```sh
pm2 start start.js --time
```
Stop:
```sh
pm2 stop start.js
```
Logs will grow quite fast. Refer to pm2 documentation for proper log management.
