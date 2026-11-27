param location string
param workspaceId string

@description('Name of the scheduled jobs Functions app. Leave empty when the jobs are not deployed.')
param jobsAppName string = ''

@minLength(1)
param emails array

@description('API requests answered with 5xx within 15 minutes before the alert fires.')
param apiErrorThreshold int = 5

resource actionGroup 'Microsoft.Insights/actionGroups@2023-01-01' = {
  name: 'splitty-alerts'
  location: 'global'
  properties: {
    groupShortName: 'splitty'
    enabled: true
    emailReceivers: [for (email, index) in emails: {
      name: 'recipient-${index}'
      emailAddress: email
      useCommonAlertSchema: true
    }]
  }
}

var jobsFilter = empty(jobsAppName) ? 'false' : 'AppRoleName =~ "${jobsAppName}"'

var rules = concat([
  {
    name: 'splitty-api-5xx'
    description: 'The API is answering requests with server errors.'
    severity: 2
    frequency: 'PT15M'
    window: 'PT15M'
    operator: 'GreaterThanOrEqual'
    threshold: apiErrorThreshold
    query: 'AppRequests | where not(${jobsFilter}) | where toint(ResultCode) >= 500'
  }
], empty(jobsAppName) ? [] : [
  {
    name: 'splitty-jobs-failed'
    description: 'A scheduled backup, purge or cleanup run failed.'
    severity: 2
    frequency: 'PT1H'
    window: 'PT1H'
    operator: 'GreaterThanOrEqual'
    threshold: 1
    query: 'AppRequests | where ${jobsFilter} | where Success == false'
  }
  {
    name: 'splitty-backup-missing'
    description: 'No successful backup in the last 26 hours. Also fires until the first backup has run after a deployment.'
    severity: 1
    frequency: 'PT1H'
    window: 'P2D'
    operator: 'LessThan'
    threshold: 1
    query: 'AppRequests | where TimeGenerated > ago(26h) | where ${jobsFilter} | where Name =~ "backup" and Success == true'
  }
])

resource alerts 'Microsoft.Insights/scheduledQueryRules@2022-06-15' = [for rule in rules: {
  name: rule.name
  location: location
  properties: {
    displayName: rule.name
    description: rule.description
    enabled: true
    severity: rule.severity
    scopes: [workspaceId]
    evaluationFrequency: rule.frequency
    windowSize: rule.window
    autoMitigate: true
    criteria: {
      allOf: [
        {
          query: rule.query
          timeAggregation: 'Count'
          operator: rule.operator
          threshold: rule.threshold
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    actions: { actionGroups: [actionGroup.id] }
  }
}]
