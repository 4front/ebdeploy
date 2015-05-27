

* IAM Policy

Ensure user has the elasticbeanstalk:UpdateEnvironment and elasticbeanstalk:UpdateEnvironment permissions.

~~~json
"Statement": [
  {
    "Sid": "Stmt1432659129000",
    "Effect": "Allow",
    "Action": [
        "elasticbeanstalk:CreateApplicationVersion",
        "elasticbeanstalk:UpdateEnvironment"
    ],
    "Resource": [
        "arn:aws:elasticbeanstalk:*"
    ]
  }
]
"Statement": [
        {
            "Sid": "Stmt1432660908000",
            "Effect": "Allow",
            "Action": [
                "cloudformation:GetTemplate",
                "cloudformation:UpdateStack",
                "cloudformation:DescribeStacks",
                "cloudformation:DescribeStackResource"
            ],
            "Resource": [
                "arn:aws:cloudformation:*"
            ]
        }
    ]
    autoscaling:SuspendProcesses
~~~

/*cloudformation:GetTemplate on resource: arn:aws:cloudformation:us-west-2:677305290892:stack/awseb-e-pr2a9fkmin-stack/fd5cbe10-02e8-11e5-9e3e-50d50205787c]*/
