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

module workspace 'workspace.bicep' = {
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
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: workspace.outputs.id
    IngestionMode: 'LogAnalytics'
    DisableIpMasking: false
  }
}

module scrub 'telemetryScrub.bicep' = if (scrubTelemetry) {
  name: 'monitoring-scrub-rule'
  params: {
    name: scrubRuleName
    location: location
    workspaceId: workspace.outputs.id
  }
}

// A workspace and its transformation rule reference each other, so the workspace is deployed
// first without the rule and updated once the rule exists. Every property is repeated because
// the second deployment replaces the first.
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

output workspaceId string = workspace.outputs.id
output workspaceName string = workspace.outputs.name
output appInsightsName string = insights.name
@secure()
output connectionString string = insights.properties.ConnectionString
