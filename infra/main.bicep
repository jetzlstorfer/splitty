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

@description('Email address of the first person, matching the import mapping.')
param memberAEmail string

@description('Email address of the second person.')
param memberBEmail string

param memberAName string
param memberBName string

@secure()
@description('Connection string from Azure Communication Services with an email domain linked.')
param emailConnectionString string

@description('Verified sender address from the linked Email Communication Services domain.')
param emailSender string

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
    MEMBER_A_EMAIL: memberAEmail
    MEMBER_B_EMAIL: memberBEmail
    MEMBER_A_NAME: memberAName
    MEMBER_B_NAME: memberBName
    LOCAL_DEVELOPMENT: 'false'
    EMAIL_CONNECTION_STRING: emailConnectionString
    EMAIL_SENDER: emailSender
  }
}

output appUrl string = 'https://${site.properties.defaultHostname}'
output staticSiteName string = site.name
output storageAccountName string = storage.name
