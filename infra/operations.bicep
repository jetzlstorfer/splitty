@description('Region for the operational resources. Keep it aligned with the data account.')
param location string = 'westeurope'

@description('Existing Static Web App name, used to name operational resources. This template does not modify the site or its settings.')
param appName string

@description('Existing account holding SplittyAuth and SplittyLedger. This template does not modify the account.')
@minLength(3)
@maxLength(24)
param storageName string

param enableMonitoring bool = false
param scrubTelemetry bool = true
@description('Set true when the monitoring workspace already exists; preserves its scrub-rule link during redeployment.')
param monitoringWorkspaceExists bool = false

@minValue(30)
@maxValue(730)
param logRetentionDays int = 30

param logDailyQuotaGb string = '0.2'
param enableScheduledJobs bool = false

@minValue(1)
param backupRetentionDays int = 30

param backupContainerName string = 'splitty-backups'

@description('Optional exact GitHub OIDC subject for a secretless jobs deployment identity scoped to the production environment.')
param jobsDeploymentSubject string = ''

param alertEmails array = []

@minValue(0)
param monthlyBudget int = 0

@description('First day of the budget month. Keep this value on subsequent deployments.')
param budgetStartDate string = utcNow('yyyy-MM-01')

var uniqueSuffix = uniqueString(resourceGroup().id)
var hasAlertRecipients = !empty(alertEmails)
var jobsAppName = '${appName}-jobs-${take(uniqueSuffix, 5)}'

module monitoring 'modules/monitoring.bicep' = if (enableMonitoring) {
  name: 'monitoring'
  params: {
    location: location
    workspaceName: '${appName}-logs'
    appInsightsName: '${appName}-insights'
    scrubRuleName: '${appName}-telemetry-scrub'
    retentionInDays: logRetentionDays
    dailyQuotaGb: logDailyQuotaGb
    scrubTelemetry: scrubTelemetry
    workspaceExists: monitoringWorkspaceExists
  }
}

module backupStorage 'modules/backupStorage.bicep' = if (enableScheduledJobs) {
  name: 'backup-storage'
  params: {
    location: location
    name: '${take(storageName, 15)}bk${take(uniqueSuffix, 7)}'
    containerName: backupContainerName
    retentionDays: backupRetentionDays
  }
}

module scheduledJobs 'modules/scheduledJobs.bicep' = if (enableScheduledJobs) {
  name: 'scheduled-jobs'
  params: {
    location: location
    functionAppName: jobsAppName
    planName: '${appName}-jobs-plan'
    hostStorageName: '${take(storageName, 15)}jh${take(uniqueSuffix, 7)}'
    dataStorageName: storageName
    backupStorageName: backupStorage.?outputs.name ?? ''
    backupContainerName: backupContainerName
    appInsightsConnectionString: monitoring.?outputs.connectionString ?? ''
  }
}

module alerts 'modules/alerts.bicep' = if (enableMonitoring && hasAlertRecipients) {
  name: 'alerts'
  params: {
    location: location
    workspaceId: monitoring.?outputs.workspaceId ?? ''
    jobsAppName: enableScheduledJobs ? jobsAppName : ''
    emails: alertEmails
  }
}

module jobsDeploymentIdentity 'modules/jobsDeploymentIdentity.bicep' = if (enableScheduledJobs && !empty(jobsDeploymentSubject)) {
  name: 'jobs-deployment-identity'
  params: {
    location: location
    functionAppName: scheduledJobs!.outputs.functionAppName
    subject: jobsDeploymentSubject
  }
}

resource budget 'Microsoft.Consumption/budgets@2023-05-01' = if (monthlyBudget > 0 && hasAlertRecipients) {
  name: '${appName}-monthly'
  properties: {
    category: 'Cost'
    amount: monthlyBudget
    timeGrain: 'Monthly'
    timePeriod: { startDate: '${budgetStartDate}T00:00:00Z' }
    notifications: {
      actual80: {
        enabled: true
        operator: 'GreaterThan'
        threshold: 80
        thresholdType: 'Actual'
        contactEmails: alertEmails
      }
      forecast100: {
        enabled: true
        operator: 'GreaterThan'
        threshold: 100
        thresholdType: 'Forecasted'
        contactEmails: alertEmails
      }
    }
  }
}

output scheduledJobsAppName string = enableScheduledJobs ? jobsAppName : ''
output backupStorageAccountName string = backupStorage.?outputs.name ?? ''
output applicationInsightsName string = monitoring.?outputs.appInsightsName ?? ''
output logAnalyticsWorkspaceName string = monitoring.?outputs.workspaceName ?? ''
output jobsDeploymentClientId string = jobsDeploymentIdentity.?outputs.clientId ?? ''
output jobsDeploymentTenantId string = jobsDeploymentIdentity.?outputs.tenantId ?? ''
output jobsDeploymentSubscriptionId string = jobsDeploymentIdentity.?outputs.subscriptionId ?? ''
@secure()
output applicationInsightsConnectionString string = monitoring.?outputs.connectionString ?? ''
