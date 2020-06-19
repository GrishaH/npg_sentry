"use strict";

const ConfigChain = require('config-chain');
const path        = require('path');
const os          = require('os');
const assert      = require('assert');
const moment      = require('moment');
const GetOpt      = require('node-getopt');

var options;

var fromCommandLine = (optionsList) => {
  var opt = new GetOpt(optionsList).bindHelp().parseSystem();
  return opt.options;
};

var provide = function(provideOpts) {
  let generateConfigs = provideOpts.generateConfigs;
  let immutable = provideOpts.immutable;
  let defaultOptions = provideOpts.defaultOptions;
  let RO_OPTION_KEY = provideOpts.ro_key;
  let adjustOptions = provideOpts.adjustOptions;

  console.log("TESTING OPTIONS");
  console.log(generateConfigs);
  console.log(immutable);
  console.log(defaultOptions);
  console.log(RO_OPTION_KEY);
  console.log(adjustOptions);

  console.log("VALUE OF OPTIONS BEFORE IF STATEMENT:");
  console.log(options);
  if (generateConfigs) {
    if (options && options.get(RO_OPTION_KEY)) {
      throw new Error('Attempt to overwrite original configuration');
    }
    assert(typeof generateConfigs === 'function', 'parameter must be a function');
    let opts = generateConfigs();
    assert(typeof opts === 'object', 'parameter must return an object');
    let tmpOptions = new ConfigChain(
      opts,
      opts.configfile
        ? path.resolve(opts.configfile)
        : null,
      defaultOptions || null
    );
    if (typeof immutable !== 'undefined') {
      assert(typeof immutable === 'boolean', 'immutable must be boolean');
      tmpOptions.set(RO_OPTION_KEY, immutable);
    }
    if (adjustOptions) {
      adjustOptions(tmpOptions);
    }
    if (tmpOptions.get(RO_OPTION_KEY)) {
      tmpOptions.set = () => {
        throw new Error('Attempt to change read-only configuration');
      };
    }
    options = tmpOptions;
  }
  console.log("VALUE OF OPTIONS AFTER IF STATEMENT:");
  console.log(options);
  assert(options, 'Options is undefined');
  return options;
};

var _formatDate = () => {
  return moment().format('YYYYMMDD_HHmmssSS');
};

var _formatRandom = () => {
  let rnd = Math.floor(Math.random() * 10000);
  return `_${rnd}`;
};

var tempFilePath = function(prefix) {
  prefix = prefix ? prefix : '';
  return path.join(os.tmpdir(), prefix + _formatDate() + _formatRandom());
};

var logOpts = function(optionsList, defaultOptions, SECRET_OPTIONS) {
  let loIndex = 1;

  let names = optionsList
    .filter(function(el) {return !el[loIndex].startsWith('help');})
    .sort(function(el1, el2) {return el1[loIndex].localeCompare(el2[loIndex]);})
    .map(function(el) {
      let desc = el[loIndex];
      return desc.split('=', 1).join('');
    });
  // Push all defaultOptions into names
  Array.prototype.push.apply(names, Object.keys(defaultOptions).sort());

  return "\n" + names
    .map(function(name) {
      let value = ( !SECRET_OPTIONS || SECRET_OPTIONS.indexOf( name ) === -1 )
        ? JSON.stringify(options.get(name))
        : '*****' ;
      return name + '=' + value;
    }).join("\n");
};

module.exports = {
  fromCommandLine: fromCommandLine,
  provide:         provide,
  tempFilePath:    tempFilePath,
  logOpts:         logOpts
};

