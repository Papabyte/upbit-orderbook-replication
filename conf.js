/*jslint node: true */
"use strict";
const path = require('path');
require('dotenv').config({ path: path.dirname(process.mainModule.paths[0]) + '/.env' });


// websocket URL of Upbit we are are connecting to
exports.upbit_ws_url = 'wss://id-api.upbit.com/websocket/v1';

exports.upbit_api_url = 'https://id-api.upbit.com'; // https://api.upbit.com



// source exchange authentication
exports.sourceApiKey = process.env.sourceApiKey;
exports.sourceApiSecret = process.env.sourceApiSecret;

// destination exchange authentication
exports.destApiKey = process.env.destApiKey;
exports.destApiSecret = process.env.destApiSecret;

exports.MARKUP = (typeof process.env.MARKUP !== 'undefined') ? parseFloat(process.env.MARKUP) : 2; // %

exports.quote_currency = 'BTC';
exports.dest_pair = 'GBYTE/' + exports.quote_currency;


exports.dest_ws_pair = 'gbyte_btc';

exports.dest_ws_market = {
  id: "BTC-GBYTE", // remote_id used by the exchange
  base: "GBYTE", 
  quote: "BTC", 
};

exports.MIN_QUOTE_BALANCE = process.env.MIN_QUOTE_BALANCE || 0.001;
exports.MIN_BASE_BALANCE = process.env.MIN_BASE_BALANCE || 0.01;

exports.MIN_DEST_ORDER_SIZE = 0.25; // in base currency
exports.MIN_SOURCE_ORDER_SIZE = 0.25; // in base currency
