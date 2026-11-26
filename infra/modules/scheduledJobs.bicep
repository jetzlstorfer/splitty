param location string
param functionAppName string
param planName string

@description('New storage account for the Functions runtime and the deployment package. It must not be the backup account: runtime blobs cannot live in an immutable container.')
param hostStorageName string

@description('Existing account that holds the SplittyAuth and SplittyLedger tables.')
param dataStorageName string

param backupStorageName string
param backupContainerName string

@secure()
param appInsightsConnectionString string = ''

var deploymentContainerName = 'deployments'
var blobOwnerRoleId = 'b7e6dc6d-f1e8-4753-8033-0f276bb0955b'
var blobContributorRoleId = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
var queueContributorRoleId = '974c5e8b-45b9-4653-ba55-5f855dd0fb88'
var tableContributorRoleId = '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3'

resource hostStorage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: hostStorageName
  location: location
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    defaultToOAuthAuthentication: true
  }
}

resource hostBlobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: hostStorage
  name: 'default'
}

resource deploymentContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: hostBlobService
  name: deploymentContainerName
  properties: { publicAccess: 'None' }
}

resource plan 'Microsoft.Web/serverfarms@2024-04-01' = {
  name: planName
  location: location
  kind: 'functionapp'
  sku: {
    name: 'FC1'
    tier: 'FlexConsumption'
  }
  properties: { reserved: true }
}

resource app 'Microsoft.Web/sites@2024-04-01' = {
  name: functionAppName
  location: location
  kind: 'functionapp,linux'
  identity: { type: 'SystemAssigned' }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    functionAppConfig: {
      deployment: {
        storage: {
          type: 'blobContainer'
          value: '${hostStorage.properties.primaryEndpoints.blob}${deploymentContainerName}'
          authentication: { type: 'SystemAssignedIdentity' }
        }
      }
      scaleAndConcurrency: {
        maximumInstanceCount: 40
        instanceMemoryMB: 2048
      }
      runtime: {
        name: 'node'
        version: '22'
      }
    }
    siteConfig: {
      appSettings: concat([
        { name: 'AzureWebJobsStorage__credential', value: 'managedidentity' }
        { name: 'AzureWebJobsStorage__blobServiceUri', value: hostStorage.properties.primaryEndpoints.blob }
        { name: 'AzureWebJobsStorage__queueServiceUri', value: hostStorage.properties.primaryEndpoints.queue }
        { name: 'AzureWebJobsStorage__tableServiceUri', value: hostStorage.properties.primaryEndpoints.table }
        { name: 'TABLE_STORAGE_ACCOUNT_NAME', value: dataStorageName }
        { name: 'BACKUP_STORAGE_ACCOUNT_NAME', value: backupStorageName }
        { name: 'BACKUP_CONTAINER_NAME', value: backupContainerName }
        { name: 'STORAGE_ENDPOINT_SUFFIX', value: environment().suffixes.storage }
      ], empty(appInsightsConnectionString) ? [] : [
        { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsightsConnectionString }
      ])
    }
  }
}

resource hostBlobOwner 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(hostStorage.id, app.id, blobOwnerRoleId)
  scope: hostStorage
  properties: {
    principalId: app.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', blobOwnerRoleId)
  }
}

resource hostQueueContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(hostStorage.id, app.id, queueContributorRoleId)
  scope: hostStorage
  properties: {
    principalId: app.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', queueContributorRoleId)
  }
}

resource hostTableContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(hostStorage.id, app.id, tableContributorRoleId)
  scope: hostStorage
  properties: {
    principalId: app.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', tableContributorRoleId)
  }
}

resource dataStorage 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: dataStorageName
}

resource dataTableContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(dataStorage.id, app.id, tableContributorRoleId)
  scope: dataStorage
  properties: {
    principalId: app.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', tableContributorRoleId)
  }
}

resource backupStorage 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: backupStorageName

  resource blobService 'blobServices' existing = {
    name: 'default'

    resource container 'containers' existing = {
      name: backupContainerName
    }
  }
}

// Scoped to the backup container so the job cannot read or write anything else in the account.
resource backupWriter 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(backupStorage::blobService::container.id, app.id, blobContributorRoleId)
  scope: backupStorage::blobService::container
  properties: {
    principalId: app.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', blobContributorRoleId)
  }
}

output functionAppName string = app.name
output principalId string = app.identity.principalId
output hostStorageName string = hostStorage.name
