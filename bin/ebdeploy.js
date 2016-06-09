#!/usr/bin/env node

var path = require('path');
var async = require('async');
var fs = require('fs');
var os = require('os');
var ncp = require('ncp');
var AWS = require('aws-sdk');
var debug = require('debug')('ebdeploy');
var readdirp = require('readdirp');
var HttpsProxyAgent = require('https-proxy-agent');
var yargs = require('yargs').argv;
var yaml = require('js-yaml');
var winston = require('winston');
var _ = require('lodash');


winston.remove(winston.transports.Console);
winston.add(winston.transports.Console, {
  level: 'info',
  prettyPrint: true,
  colorize: true,
  silent: false,
  timestamp: false
});
var log = winston;

var params = _.assign({}, yargs, {
  sourceDir: process.cwd(),
  versionLabel: 'ebdeploy-' + Date.now(),
});

params.awsConfig = {
  // logger: process.stdout,
  region: yargs.region || 'us-west-2',
  maxRetries: 0,
  httpOptions: {
    timeout: 30000
  }
};

if (yargs.profile) {
  log.info('using AWS profile %s', yargs.profile);
  params.awsConfig.credentials = new AWS.SharedIniFileCredentials({profile: yargs.profile});
}

if (process.env.HTTPS_PROXY) {
  log.info('setting http proxy to %s', process.env.HTTPS_PROXY);
  params.awsConfig.httpOptions.agent = new HttpsProxyAgent(process.env.HTTPS_PROXY);
}

log.info('updating AWS config');
AWS.config.update(params.awsConfig);

var tasks = [];

tasks.push(loadDeployConfig);
tasks.push(createTempWorkingDirectory);
tasks.push(copyFiles);

// Register task to create the zip archive
tasks.push(function(cb) {
  require('../lib/zip')(params, cb);
});

// If not a dryrun, register task to deploy to EB
if (params.dryRun !== true) {
  tasks.push(function(cb) {
    require('../lib/deploy')(params, cb);
  });
}

async.series(tasks, function(err) {
  if (err) {
    log.error(err.message);
    process.exit(1);
  } else {
    log.info('Deployment %s complete to all environments', params.versionLabel);
    process.exit(0);
  }
});

function createTempWorkingDirectory(callback) {
  params.workingDir = path.join(os.tmpdir(), params.versionLabel);
  fs.mkdir(params.workingDir, callback);
}

function loadDeployConfig(callback) {
  // Look for a .ebdeploy.yml file in the workding dir
  var config;
  var yamlConfig = path.join(process.cwd(), '.ebdeploy.yml');
  fs.readFile(yamlConfig, function(err, data) {
    if (err) {
      if (err.code === 'ENOENT') {
        return callback('No .ebdeploy.yml file found');
      }
      return callback(err);
    }

    try {
      config = yaml.safeLoad(data, 'utf-8');
    } catch (yamlErr) {
      return callback(new Error('Invalid .ebdeploy.yml: ' + yamlErr.message));
    }

    if (!_.isArray(config.environments) || _.isEmpty(config.environments)) {
      return callback(new Error('At least one ElasticBeanstalk environment must be specified'));
    }

    _.assign(params, config);

    callback(null);
  });
}

// Create a temporary directory and copy all the necessary files outside of the
function copyFiles(callback) {
  log.info('copying files to %s', params.workingDir);

  // Copy everything except node_modules to the tempDirectory
  readdirp({
    root: params.sourceDir,
    directoryFilter: ['!.git', '!node_modules'],
    depth: 0,
    entryType: 'both'
  }, function(err, res) {
    if (err) return callback(err);

    var all = res.files.concat(res.directories);

    async.each(all, function(fileInfo, cb) {
      ncp(fileInfo.fullPath, path.join(params.workingDir, fileInfo.path), cb);
    }, callback);
  });
}

// https://github.com/jsebfranck/elastic-beanstalk.js/blob/master/lib/awsClient.js
