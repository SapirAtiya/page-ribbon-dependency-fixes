"use strict";
var _eslintparser = require("typescript-eslint").parser;
var _packagejson = require("../package.json");
var parser = {
    parse: _eslintparser.parse,
    parseForESLint: _eslintparser.parseForESLint,
    meta: {
        name: 'eslint-config-next/parser',
        version: _packagejson.version
    }
};
module.exports = parser;
