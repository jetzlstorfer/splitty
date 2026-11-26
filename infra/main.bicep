@description('Region for the storage account and managed API.')
param location string = 'westeurope'

@description('Globally unique Static Web App name.')
param appName string

@description('Globally unique storage account name: 3-24 lowercase letters/numbers.')
@minLength(3)
@maxLength(24)
param storageName string

@description('Storage authentication mode. Use rbac for keyless staging deployments.')
@allowed([
  'connectionString'
  'rbac'
])
param storageAuthMode string = 'connectionString'

@description('Workforce tenant ID for the storage service principal. Required when storageAuthMode is rbac.')
param storageTenantId string = ''

@description('Client ID for the storage service principal. Required when storageAuthMode is rbac.')
param storageClientId string = ''

@secure()
@description('Client secret for the storage service principal. Required when storageAuthMode is rbac.')
param storageClientSecret string = ''

@description('Object ID of the storage service principal, used for its data-plane role assignment.')
param storagePrincipalObjectId string = ''

@description('A stable identifier for the legacy shared household. Leave empty for hosted multi-tenant sign-in.')
param householdId string = ''

param memberAName string = 'First person'
param memberBName string = 'Second person'

@secure()
@description('Reusable 43-character base64url token for the first person.')
param memberAToken string = ''

@secure()
@description('Reusable 43-character base64url token for the second person.')
param memberBToken string = ''

@description('Entra External ID authority URL, for example https://tenant.ciamlogin.com.')
param entraAuthority string = ''

@description('Entra External ID application client ID.')
param entraClientId string = ''

@secure()
@description('Entra External ID application client secret.')
param entraClientSecret string = ''

@description('Create Log Analytics and Application Insights for the API and the scheduled jobs. Enable before opening public sign-up.')
param enableMonitoring bool = false

@description('Redact credentials, tokens, e-mail addresses and query strings from telemetry before it is stored. Only used with enableMonitoring.')
param scrubTelemetry bool = true

@minValue(30)
@maxValue(730)
param logRetentionDays int = 30

@description('Daily Log Analytics ingestion cap in GB. Ingestion, including alert data, stops for the rest of the day once reached.')
param logDailyQuotaGb string = '0.2'

@description('Deploy the timer-triggered Functions app that backs up data and purges expired records, with its storage. Enable before opening public sign-up.')
param enableScheduledJobs bool = false

@minValue(1)
@description('Days a backup cannot be modified or deleted; backups are removed one day later.')
param backupRetentionDays int = 30

param backupContainerName string = 'splitty-backups'

@description('Recipients for alerts and budget notifications. Alerts and the budget are only created when this is not empty.')
param alertEmails array = []

@minValue(0)
@description('Monthly budget for the resource group in the billing currency. 0 disables the budget; it also needs alertEmails.')
param monthlyBudget int = 0

@description('First day of the month the budget starts. Pin it when redeploying later than the month it was created.')
param budgetStartDate string = utcNow('yyyy-MM-01')

var useStorageRbac = storageAuthMode == 'rbac'
var storageTableDataContributorRoleId = '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3'
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
    dataStorageName: storage.name
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

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageName
  location: location
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowBlobPublicAccess: false
    allowSharedKeyAccess: !useStorageRbac
  }
}

resource storageTableDataContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (useStorageRbac) {
  name: guid(storage.id, storagePrincipalObjectId, storageTableDataContributorRoleId)
  scope: storage
  properties: {
    principalId: storagePrincipalObjectId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageTableDataContributorRoleId)
  }
}

resource site 'Microsoft.Web/staticSites@2023-12-01' = {
  name: appName
  location: location
  sku: {
    name: 'Free'
    tier: 'Free'
  }
  properties: {
    allowConfigFileUpdates: true
    stagingEnvironmentPolicy: 'Disabled'
  }
}

resource settings 'Microsoft.Web/staticSites/config@2023-12-01' = {
  parent: site
  name: 'appsettings'
  properties: union({
      APP_ORIGIN: 'https://${site.properties.defaultHostname}'
      LOCAL_DEVELOPMENT: 'false'
    }, useStorageRbac ? {
      TABLE_STORAGE_ACCOUNT_NAME: storage.name
      TABLE_STORAGE_TENANT_ID: storageTenantId
      TABLE_STORAGE_CLIENT_ID: storageClientId
      TABLE_STORAGE_CLIENT_SECRET: storageClientSecret
    } : {
      TABLE_STORAGE_CONNECTION_STRING: 'DefaultEndpointsProtocol=https;AccountName=${storage.name};AccountKey=${storage.listKeys().keys[0].value};EndpointSuffix=${environment().suffixes.storage}'
    }, (!empty(householdId) || !empty(memberAToken) || !empty(memberBToken)) ? {
      HOUSEHOLD_ID: householdId
      MEMBER_A_TOKEN: memberAToken
      MEMBER_B_TOKEN: memberBToken
      MEMBER_A_NAME: memberAName
      MEMBER_B_NAME: memberBName
    } : {}, (!empty(entraAuthority) || !empty(entraClientId) || !empty(entraClientSecret)) ? {
      ENTRA_AUTHORITY: entraAuthority
      ENTRA_CLIENT_ID: entraClientId
      ENTRA_CLIENT_SECRET: entraClientSecret
    } : {}, enableMonitoring ? {
      APPLICATIONINSIGHTS_CONNECTION_STRING: monitoring.?outputs.connectionString ?? ''
    } : {})
}

@description('Azure Table Storage Data Contributor role assignment for the keyless storage service principal.')
output storageTableDataContributorAssignmentId string = useStorageRbac ? storageTableDataContributor.id : ''
output appUrl string = 'https://${site.properties.defaultHostname}'
output staticSiteName string = site.name
output storageAccountName string = storage.name
output scheduledJobsAppName string = enableScheduledJobs ? jobsAppName : ''
output backupStorageAccountName string = backupStorage.?outputs.name ?? ''
output applicationInsightsName string = monitoring.?outputs.appInsightsName ?? ''
output logAnalyticsWorkspaceName string = monitoring.?outputs.workspaceName ?? ''
