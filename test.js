var AWS = require('aws-sdk');

var versionLabel = "ebdeploy-1432660528935";

var elasticbeanstalk = new AWS.ElasticBeanstalk({
  region: 'us-west-2'
});

var options = {
  EnvironmentName: "aerobatic-prod",
  VersionLabel: versionLabel
};

elasticbeanstalk.updateEnvironment(options, function(err, data) {
  if (err)
    console.log(err);
  else
    console.log(data);
});
