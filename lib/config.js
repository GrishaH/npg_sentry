'use strict';

const configger = require('./configger');

const optionsList = [
  ['p','port=PORT'        ,'PORT to listen on'],
  ['m','mongourl=URI'     ,'URI to connect to mongodb'],
  ['c','configfile=PATH'  ,'location of config file'],
  ['' ,'loglevel=[error|warn|info|debug]','set logging level [default: error]'],
  ['' ,'no-ssl'           ,'run server on http'],
  ['' ,'sslcert=PATH'     ,'certificate for https server'],
  ['' ,'sslkey=PATH'      ,'private key for https server'],
  ['' ,'sslca=PATH'       ,'CA certificate for verifying requests'],
  ['V','version'          ,'show version'],
  ['h','help'             ,'show this help'],
];

const SECRET_OPTIONS = ['sslpassphrase'];

const defaultOptions = {
  port: 8000,
  mongourl: 'mongodb://localhost:27017/test',
  loglevel: 'error',
  mongoopt: {
    db: {
      numberofRetries: 5
    },
    server: {
      auto_reconnect: true,
      poolSize:       40,
      socketOptions:  {
        connectTimeoutMS: 5000
      }
    },
    replSet: {},
    mongos:  {}
  }
};

function fromCommandLine() {
  return configger.fromCommandLine(optionsList);
}

function provide(generateConfigs, immutable) {
  let provideOpts = {
    generateConfigs,
    immutable,
    defaultOptions,
    ro_key: 'config_ro',
    adjustOptions: null
  };
  // TODO
  console.log("Generate Configs is set as:");
  console.log(generateConfigs);
  if (generateConfigs) { console.log(generateConfigs.toString()); }
  return configger.provide(provideOpts);
}

function logOpts() {
  return configger.logOpts(optionsList, defaultOptions, SECRET_OPTIONS);
}

console.log("check code execution");
module.exports = {
  fromCommandLine,
  provide,
  logOpts,
  tempFilePath: configger.tempFilePath,
};
