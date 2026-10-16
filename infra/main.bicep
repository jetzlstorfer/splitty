@description('Region for the storage account and managed API.')
param location string = 'westeurope'

@description('Globally unique Static Web App name.')
param appName string

@description('Globally unique storage account name: 3-24 lowercase letters/numbers.')
@minLength(3)
@maxLength(24)
param storageName string

@description('A stable identifier for your shared household. Do not change after importing.')
param householdId string = 'our-household'

param memberAName string
param memberBName string

@secure()
@minLength(43)
@maxLength(43)
@description('Reusable 43-character base64url token for the first person.')
param memberAToken string

@secure()
@minLength(43)
@maxLength(43)
@description('Reusable 43-character base64url token for the second person.')
param memberBToken string

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageName
  location: location
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowBlobPublicAccess: false
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
  properties: {
    APP_ORIGIN: 'https://${site.properties.defaultHostname}'
    HOUSEHOLD_ID: householdId
    TABLE_STORAGE_CONNECTION_STRING: 'DefaultEndpointsProtocol=https;AccountName=${storage.name};AccountKey=${storage.listKeys().keys[0].value};EndpointSuffix=${environment().suffixes.storage}'
    MEMBER_A_TOKEN: memberAToken
    MEMBER_B_TOKEN: memberBToken
    MEMBER_A_NAME: memberAName
    MEMBER_B_NAME: memberBName
    LOCAL_DEVELOPMENT: 'false'
  }
}

output appUrl string = 'https://${site.properties.defaultHostname}'
output staticSiteName string = site.name
output storageAccountName string = storage.name
