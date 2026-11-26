@description('Log Analytics workspace name.')
param name string

param location string

@minValue(30)
@maxValue(730)
param retentionInDays int

@description('Daily ingestion cap in GB, for example 0.2. Ingestion stops for the rest of the day once it is reached.')
param dailyQuotaGb string

@description('Workspace-transformation data collection rule to apply to all ingestion. Empty until the rule exists.')
param transformRuleId string = ''

resource workspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: name
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: retentionInDays
    workspaceCapping: { dailyQuotaGb: json(dailyQuotaGb) }
    features: { enableLogAccessUsingOnlyResourcePermissions: true }
    defaultDataCollectionRuleResourceId: empty(transformRuleId) ? null : transformRuleId
  }
}

output id string = workspace.id
output name string = workspace.name
