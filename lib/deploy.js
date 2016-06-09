var async = require('async');
var AWS = require('aws-sdk');
var log = require('winston');
var fs = require('fs');
var path = require('path');
var _ = require('lodash');

// Deploy the zip to each ElasticBeanstalk target
module.exports = function(params, done) {
  async.series([
    ensureAllEnvironmentsReady,
    function(cb) {
      async.each(params.environments, function(environment, next) {
        deployToEnvironment(environment, next);
      }, cb);
    }
  ], done);

  function ensureAllEnvironmentsReady(callback) {
    async.map(params.environments, getEnvironmentInfo, function(err, environments) {
      if (err) return callback(err);
      var nonReadyEnvironments = _.filter(environments, function(environment) {
        return environment.Status !== 'Ready';
      });

      if (nonReadyEnvironments.length > 0) {
        return callback(new Error('The following environments are not in Ready state: ' +
          _.map(nonReadyEnvironments, 'EnvironmentName').join(', ')));
      }
      callback();
    });
  }

  function deployToEnvironment(environment, callback) {
    log.info('Deploying to %s', environment.environmentName);
    var s3Key = environment.applicationName + '/' + params.versionLabel + '.zip';
    async.series([
      function(cb) {
        uploadArchiveToS3(environment, s3Key, cb);
      },
      function(cb) {
        createElasticBeanstalkVersion(environment, s3Key, cb);
      },
      function(cb) {
        waitForDeploymentToComplete(environment, cb);
      }
    ], function(err) {
      if (err) {
        log.error('Error deploying to environment %s: %s',
          environment.environmentName, err.message);
        return callback();
      }
      callback();
    });
  }

  function getEnvironmentInfo(environment, callback) {
    var elasticbeanstalk = new AWS.ElasticBeanstalk({region: environment.region});

    elasticbeanstalk.describeEnvironments({
      ApplicationName: environment.applicationName,
      EnvironmentNames: [environment.environmentName]
    }, function(err, data) {
      if (err) return callback(err);
      if (data.Environments.length === 0) {
        return callback(new Error('Invalid environment ' + environment.environmentName));
      }
      callback(null, data.Environments[0]);
    });
  }

  function uploadArchiveToS3(environment, s3Key, callback) {
    log.info('Uploading version archive to S3 for %s with key %s',
      environment.environmentName, s3Key);

    var archiveFile = path.join(params.workingDir, params.versionLabel + '.zip');

    var s3 = new AWS.S3({region: environment.region});
    s3.putObject({
      Key: s3Key,
      Body: fs.createReadStream(archiveFile),
      Bucket: environment.versionsBucket
    }, callback);
  }

  function createElasticBeanstalkVersion(environment, s3Key, callback) {
    log.info('Creating version %s for environment',
      params.versionLabel, environment.environmentName);

    var elasticbeanstalk = new AWS.ElasticBeanstalk({region: environment.region});

    async.series([
      function(cb) {
        var ebParams = {
          ApplicationName: environment.applicationName,
          VersionLabel: params.versionLabel,
          AutoCreateApplication: false,
          SourceBundle: {
            S3Bucket: environment.versionsBucket,
            S3Key: s3Key
          }
        };

        elasticbeanstalk.createApplicationVersion(ebParams, cb);
      },
      function(cb) {
        var options = {
          EnvironmentName: environment.environmentName,
          VersionLabel: params.versionLabel
        };

        elasticbeanstalk.updateEnvironment(options, cb);
      }
    ], callback);
  }

  function waitForDeploymentToComplete(environment, callback) {
    var deploymentComplete = false;
    var startTime = Date.now();

    var test = function() {
      log.debug('deploymentComplete=%s', deploymentComplete);
      return deploymentComplete === true;
    };

    async.until(test, function(cb) {
      // Poll for the EB environment every 5 seconds until the status is Ready
      setTimeout(function() {
        getEnvironmentInfo(environment, function(err, info) {
          if (err) return cb(err);

          var duration = Math.round((Date.now() - startTime) / 1000);

          if (info.Status === 'Ready') {
            deploymentComplete = true;
            log.info('Environment %s completed after %s seconds',
              environment.environmentName, duration);
            return cb();
          }

          if (info.HealthStatus === 'Severe') {
            return cb(new Error('Environment %s is in Severe status',
              environment.environmentName));
          }

          if (info.Status !== 'Updating') {
            return cb(new Error('Unexpected environment status %s in %s',
              info.Status, environment.environmentName));
          }

          log.info('Environment %s updating for %s seconds',
            environment.environmentName, duration);

          cb();
        });
      }, 20000);
    }, callback);
  }
};
