#!/usr/bin/env node

var archiver = require('archiver');
var path = require('path');
var async = require('async');
var fs = require('fs');
var os = require('os');
var ncp = require('ncp');
var npmi = require('npmi');
var AWS = require('aws-sdk');
var debug = require('debug')('ebdeploy');
var readdirp = require('readdirp');
var rimraf = require('rimraf');
var spawn = require('child_process').spawn;
var yargs = require('yargs').argv;

validateArgs();

var versionLabel = 'ebdeploy-' + Date.now();

if (yargs._.length === 0)
  sourceDir = process.cwd();
else
  sourceDir = yargs._[0];

var packageJson;
var tasks = [];

if (yargs.tempDir) {
  tasks.push(createTempWorkingDirectory);
  tasks.push(copyFiles);
}
else {
  workingDir = sourceDir;
}

var awsOptions = {
  region: yargs.region || 'us-west-2'
};

var elasticbeanstalk = new AWS.ElasticBeanstalk(awsOptions);
var s3 = new AWS.S3(awsOptions);

tasks.push(loadPackageJson);
tasks.push(deleteNodeModules);
tasks.push(npmInstall);

if (yargs.skipOptionalDependencies === true)
  tasks.push(stripOptionalDependencies);

tasks.push(revisedPackageJson);
tasks.push(generateZipArchive);
tasks.push(uploadArchiveToS3);
tasks.push(createElasticBeanstalkVersion);
tasks.push(updateBeanstalkEnvironmentVersion);

async.series(tasks, function(err) {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  else {
    console.log("deployment %s complete", versionLabel);
    process.exit(0);
  }
});

function deleteNodeModules(callback) {
  rimraf(path.join(workingDir, 'node_modules'), callback);
}

function createTempWorkingDirectory(callback) {
  workingDir = path.join(os.tmpdir(), versionLabel);
  fs.mkdir(workingDir, callback);
}

// Create a temporary directory and copy all the necessary files outside of the
function copyFiles(callback) {
  console.log("copying files to %s", workingDir);

  // Copy everything except node_modules to the tempDirectory
  readdirp({
    root: sourceDir,
    directoryFilter: ['!.git', '!node_modules'],
    depth: 0,
    entryType: 'both'
  }, function(err, res) {
    if (err) return callback(err);

    var all = res.files.concat(res.directories);

    async.each(all, function(f, cb) {
      ncp(f.fullPath, path.join(workingDir, f.path), cb);
    }, callback);
  });
}

function loadPackageJson(callback) {
  fs.readFile(path.join(workingDir, 'package.json'), function(err, data) {
    if (err) return callback(err);

    try {
      packageJson = JSON.parse(data);
    }
    catch (err) {
      return callback(new Error("Invalid package.json"));
    }

    callback();
  });
}

function npmInstall(callback) {
  console.log("running npm install");

  var npmArgs = ['install', '--production'];
  if (yargs.skipOptionalDependencies === true)
    npmArgs.push('--no-optional');

  var child = spawn('npm', npmArgs, {cwd: workingDir});
  child.stdout.on('data', function(data) {
    console.log(data.toString());
  });

  child.stderr.on('data', function(data) {
    console.error(data.toString());
  });

  child.on('error', function(err) {
    return callback(err);
  });

  child.on('close', function(code) {
    if (code !== 0)
      return callback(new Error("npm install did not exit normally"));

    return callback();
  });
}

// Even though we are shipping node_modules in the zip,
// ElasticBeanstalk is still going to run npm install and
// and we are not able to specify the --skip-optional flag.
// So instead strip out all optionalDependency sections from
// each package.json file.
function stripOptionalDependencies(callback) {
  console.log("Stripping optional dependencies from package.json files");

  var opts = {
    root: workingDir,
    fileFilter: function(entry) {
      return entry.name === 'package.json';
    }
  };

  readdirp(opts, function(err, res) {
    if (err) return callback(err);

    async.each(res.files, function(f, cb) {
      fs.readFile(f.fullPath, function(err, json) {
        if (err) return cb(err);

        var packageJson;
        try {
          packageJson = JSON.parse(json);
        }
        catch (err) {
          return cb(new Error("File " + f.path + " is not valid JSON"));
        }

        if (!packageJson.optionalDependencies)
          return cb();

        // Delete the optionalDependencies section and save the file back
        debug("stripping optionalDependencies from %s", f.path);
        delete packageJson.optionalDependencies;
        fs.writeFile(f.fullPath, JSON.stringify(packageJson, null, 2), cb);
      });
    }, callback);
  });
}

// Write a modified package.json without any dependencies.
function revisedPackageJson(callback) {
  console.log("revised package.json without dependencies");

  if (packageJson.scripts) {
    // We've already performed the preinstall locally
    delete packageJson.scripts.preinstall;
  }

  packageJson.dependencies = {};
  packageJson.devDependencies = {};

  fs.writeFile(path.join(workingDir, 'ebpackage.json'), JSON.stringify(packageJson, null, 2), callback);
}

function generateZipArchive(callback) {
  var zipFile = path.join(workingDir, versionLabel + '.zip');
  console.log("generating zip archive %s", zipFile);

  var erroredOut = false;
  var zipStream = fs.createWriteStream(zipFile);
  var archive = archiver('zip');

  // Make sure we don't include the zip file itself or the temporary ebpackage.json
  var fileFilters = ['!' + versionLabel + '.zip', '!ebpackage.json'], directoryFilters = [];

  fs.readFile(path.join(workingDir, ".ebignore"), function(err, ebIgnore) {
    if (err) {
      if (err.code === 'ENOENT')
        return callback(new Error("No .ebinclude file found"));
      else
        return callback(err);
    }

    // Read in the .ebinclude patterns
    var globPatterns = ebIgnore.toString().split('\n');
    globPatterns.forEach(function(pattern) {
      // TODO: Disallow negation patterns in .ebignore
      // Force all patterns to be negation patterns
      // Directory filter patterns must end in a slash
      if (pattern.slice(-1) === '/') {
        directoryFilters.push('!' + pattern.slice(0, -1));
      }
      else {
        fileFilters.push('!' + pattern);
      }
    });

    var entryStream = readdirp({
      root: workingDir,
      fileFilter: fileFilters,
      directoryFilter: directoryFilters
    })
    .on('data', function(entry) {
      // Don't include the original package.json
      if (entry.path === '/package.json')
        return;

      // Add the file to the zip archive
      debug('writing entry %s to archive', entry.path);
      archive.file(entry.fullPath, {name: entry.path});
    })
    .on('error', function(err) {
      erroredOut = true;
      return callback(err);
    })
    .on('end', function() {
      // Write the revised ElasticBeanstalk package.json
      debug("writing revised package.json");
      archive.file(path.join(workingDir, 'ebpackage.json'), {name: 'package.json'});

      debug("finalizing archive");
      archive.finalize();
    });

    zipStream.on('close', function() {
      console.log("done writing to zip archive");
      callback();
    });

    archive.on('error', function(err) {
      debug("archiver error");
      if (erroredOut !== true)
      callback(err);
    });

    archive.pipe(zipStream);
  });
}

function uploadArchiveToS3(callback) {
  console.log("uploading deploy zip to S3");

  s3.putObject({
    Key: yargs.appName + "/" + versionLabel + ".zip",
    Body: fs.createReadStream(path.join(workingDir, versionLabel + '.zip')),
    Bucket: yargs.bucket
  }, callback);
}

function createElasticBeanstalkVersion(callback) {
  console.log("Creating ElasticBeanstalk version");

  // TODO: Read this from the .elasticbeanstalk/config.yml file
  var params = {
    ApplicationName: yargs.appName,
    VersionLabel: versionLabel,
    AutoCreateApplication: false,
    SourceBundle: {
      S3Bucket: yargs.bucket,
      S3Key: yargs.appName + "/" + versionLabel + '.zip'
    }
  };

  elasticbeanstalk.createApplicationVersion(params, function(err, data) {
    if (err) return callback(err);

    console.log("create version data: %o", data);
    callback();
  });
}

function updateBeanstalkEnvironmentVersion(callback) {
  console.log("deploying version %s to environment %s", versionLabel, yargs.environment);

  var options = {
    EnvironmentName: yargs.environment,
    VersionLabel: versionLabel
  };

  elasticbeanstalk.updateEnvironment(options, callback);
}

function validateArgs() {
  if (!yargs.region)
    yargs.region = 'us-west-2';

  var error;
  if (!yargs.appName)
    error = "Missing --app-name argument";
  else if (!yargs.environment)
    error = "Missing --app-name argument";
  else if (!yargs.bucket)
    error = "Missing --bucket argument";

  if (error) {
    console.error(error);
    process.exit(1);
  }
}

// https://github.com/jsebfranck/elastic-beanstalk.js/blob/master/lib/awsClient.js
