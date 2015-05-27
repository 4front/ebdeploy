#!/usr/bin/env node

var archiver = require('archiver');
var path = require('path');
var async = require('async');
var fs = require('fs');
var os = require('os');
var ncp = require('ncp');
var npmi = require('npmi');
var npm = require('npm');
var AWS = require('aws-sdk');
var child_process = require('child_process');
var yargs = require('yargs').argv;

var versionLabel = 'ebdeploy-' + Date.now();

if (yargs._.length === 0)
  appDir = process.cwd();
else
  appDir = yargs._[0];

var tempDir = path.join(os.tmpdir(), versionLabel);
var packageJson;
var deployFiles = [];
var deployBucket = "elasticbeanstalk-us-west-2-677305290892";
var appName = "aerobatic-platform";
var beanstalkEnvironment = "aerobatic-prod";

var elasticbeanstalk = new AWS.ElasticBeanstalk({
  region: 'us-west-2'
});

async.series([
  function(cb) {
    fs.mkdir(tempDir, cb);
  },
  copyFiles,
  npmInstall,
  // npmDedupe,
  // Run integration tests?
  // Could run npm dedupe here
  updatePackageJson,
  generateZipArchive,
  uploadArchiveToS3,
  createElasticBeanstalkVersion,
  updateBeanstalkEnvironmentVersion
], function(err) {
  if (err)
    console.error(err);
  else
    console.log("deploy contents in %s", tempDir);
});

// Create a temporary directory and copy all the necessary files outside of the
function copyFiles(callback) {
  console.log("copying files to %s", tempDir);

  // Copy everything except node_modules
  // fs.readdirp({
  //   root: appDir,
  //   depth: 1,
  //   entryType: 'both'
  // }, function(err, files) {
  //   if (err) return callback(err);
  //
  //   async.each(files, )
  // });

  fs.readFile(path.join(appDir, 'package.json'), function(err, json) {
    if (err) return callback(err);

    packageJson = JSON.parse(json);
    deployFiles = packageJson.files;

    if (deployFiles.indexOf('package.json') === -1)
      deployFiles.push('package.json');

    async.each(deployFiles, function(f, cb) {
      ncp(path.join(appDir, f), path.join(tempDir, f), cb);
    }, callback);
  });
}

function npmInstall(callback) {
  console.log("running npm install");

  var options = {
    path: tempDir,
    npmLoad: {
      logLevel: 'silent',
      production: true // Don't install devDependencies
    }
  };

  npmi(options, callback);
}

function npmDedupe(callback) {
  console.log("Running npm dedupe");
  var child = child_process.spawn('npm', ['dedupe'], {cwd: tempDir});
  child.stdout.pipe(fs.createWriteStream('/dev/null', {flags: 'a'}));
  child.stderr.on('data', function(data) {
    console.log("stderr: " + data);
  });

  child.on('error', callback);
  child.on('close', callback);
}

// function runPostInstall(callback) {
//   var scripts = packageJson.scripts;
//   if (!scripts || !scripts.postinstall)
//     return callback();
//
//   var child = child_process.spawn('npm', ['run-script', 'postinstall'], {cwd: tempDir});
//   child.stdout.pipe(fs.createWriteStream('/dev/null', {flags: 'a'}));
//   child.stderr.on('data', function(data) {
//     console.log("stderr: " + data)
//   });
//
//   child.on('close', callback);
// }

// Resave package.json with an empty set of dependencies or only those
// that have binary dependencies that need to be installed to handle platform
// specific compilation.
function updatePackageJson(callback) {
  console.log("update package.json without dependencies");

  if (packageJson.scripts) {
    // We've already performed the preinstall locally
    delete packageJson.scripts.preinstall;
  }

  packageJson.dependencies = {};
  packageJson.devDependencies = {};

  fs.writeFile(path.join(tempDir, 'package.json'), JSON.stringify(packageJson, null, 2), callback);
}

function generateZipArchive(callback) {
  var zipFile = path.join(tempDir, versionLabel + '.zip');
  console.log("generating zip archive %s", zipFile);

  // zip -r deploy.zip ./
  // Shell out to zip command rather than using a node module as it's much faster
  // and it automatically handles symlinks
  var child = child_process.spawn('zip', ['-r', versionLabel + '.zip', './'], {cwd: tempDir});
  child.stdout.pipe(fs.createWriteStream('/dev/null', {flags: 'a'}));
  child.stderr.on('data', function(data) {
    console.log("stderr: " + data)
  });

  child.on('close', callback);

  // child_process.exec(cmd, {cwd: tempDir}, function (error, stdout, stderr) {
  //   if (error) return callback(error);
  //
  //   callback();
  // });

    // console.log('stdout: ' + stdout);
    // console.log('stderr: ' + stderr);
    // if (error !== null) {
    //   console.log('exec error: ' + error);
    // }
    //
  // var spawn = require()


  // var output = fs.createWriteStream(zipFile);
  // var archive = archiver('zip');
  //
  // output.on('close', function() {
  //   console.log(archive.pointer() + ' total bytes');
  //
  //   callback();
  // });
  //
  // archive.on('error', function(err) {
  //   callback(err);
  // });
  //
  // archive.pipe(output);
  //
  // deployFiles.push("node_modules");
  // async.each(deployFiles, function(f, cb) {
  //   var fullPath = path.join(tempDir, f);
  //
  //   fs.stat(fullPath, function(err, stats) {
  //     if (err) return cb(err);
  //
  //     console.log("writing %s to zip archive", f);
  //     if (stats.isDirectory())
  //       archive.directory(fullPath, f);
  //     else {
  //       archive.file(fullPath, {name: f});
  //     }
  //     cb();
  //   });
  // }, function(err) {
  //   if (err)
  //     return callback(err);
  //
  //   archive.finalize();
  // });
}

function uploadArchiveToS3(callback) {
  console.log("uploading deploy zip to S3");
  var s3 = new AWS.S3({
    region: "us-west-2"
  });

  s3.putObject({
    Key: appName + "/" + versionLabel + ".zip",
    Body: fs.createReadStream(path.join(tempDir, versionLabel + '.zip')),
    Bucket: deployBucket
  }, callback);
}

function createElasticBeanstalkVersion(callback) {
  console.log("Creating ElasticBeanstalk version");

  // TODO: Read this from the .elasticbeanstalk/config.yml file
  var params = {
    ApplicationName: appName,
    VersionLabel: versionLabel,
    AutoCreateApplication: false,
    SourceBundle: {
      S3Bucket: deployBucket,
      S3Key: appName + "/" + versionLabel + '.zip'
    }
  };
  elasticbeanstalk.createApplicationVersion(params, function(err, data) {
    if (err) return callback(err);

    console.log("create version data: %o", data);
    callback();
  });
}

function updateBeanstalkEnvironmentVersion(callback) {
  console.log("deploying version %s to environment %s", versionLabel, beanstalkEnvironment);

  var options = {
    EnvironmentName: beanstalkEnvironment,
    VersionLabel: versionLabel
  };

  elasticbeanstalk.updateEnvironment(options, callback);
};

// https://github.com/jsebfranck/elastic-beanstalk.js/blob/master/lib/awsClient.js
