param location string
param workspaceName string
param appInsightsName string
param scrubRuleName string

@minValue(30)
@maxValue(730)
param retentionInDays int

param dailyQuotaGb string

@description('Apply the workspace transformation that redacts sensitive telemetry.')
param scrubTelemetry bool

@description('Set true after the first deployment to avoid temporarily removing the workspace scrubbing rule.')
param workspaceExists bool = false

var workspaceId = resourceId('Microsoft.OperationalInsights/workspaces', workspaceName)

module workspace 'workspace.bicep' = if (!workspaceExists) {
  name: 'monitoring-workspace'
  params: {
    name: workspaceName
    location: location
    retentionInDays: retentionInDays
    dailyQuotaGb: dailyQuotaGb
  }
}

resource insights 'Microsoft.Insights/components@2020-02-02' = {
  name: appInsightsName
  location: location
  kind: 'web'
  dependsOn: [workspace]
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: workspaceId
    IngestionMode: 'LogAnalytics'
    DisableIpMasking: false
  }
}

resource existingWorkspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' existing = {
  name: workspaceName
}

// Explicit table configuration enables workspace transformations, including on built-in tables.
resource telemetryTables 'Microsoft.OperationalInsights/workspaces/tables@2022-10-01' = [for tableName in [
  'AppRequests'
  'AppTraces'
  'AppExceptions'
  'AppDependencies'
]: {
  parent: existingWorkspace
  name: tableName
  dependsOn: [insights]
  properties: {
    schema: { name: tableName }
    retentionInDays: retentionInDays
    totalRetentionInDays: retentionInDays
  }
}]

module scrub 'telemetryScrub.bicep' = if (scrubTelemetry) {
  name: 'monitoring-scrub-rule'
  dependsOn: [telemetryTables]
  params: {
    name: scrubRuleName
    location: location
    workspaceId: workspaceId
  }
}

// A workspace and its transformation rule reference each other, so the workspace is deployed
// first without the rule and updated once the rule exists. Skip that initial deployment on
// subsequent runs so ingestion is never briefly left without the scrubbing rule.
module linkedWorkspace 'workspace.bicep' = if (scrubTelemetry) {
  name: 'monitoring-workspace-linked'
  dependsOn: [scrub]
  params: {
    name: workspaceName
    location: location
    retentionInDays: retentionInDays
    dailyQuotaGb: dailyQuotaGb
    transformRuleId: resourceId('Microsoft.Insights/dataCollectionRules', scrubRuleName)
  }
}

output workspaceId string = workspaceId
output workspaceName string = workspaceName
output appInsightsName string = insights.name
@secure()
output connectionString string = insights.properties.ConnectionString
