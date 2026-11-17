@description('Region for the storage account and managed API.')
param location string = 'westeurope'

@description('Globally unique Static Web App name.')
param appName string

@description('Globally unique storage account name: 3-24 lowercase letters/numbers.')
@minLength(3)
@maxLength(24)
param storageName string

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
  properties: union({
      APP_ORIGIN: 'https://${site.properties.defaultHostname}'
      TABLE_STORAGE_CONNECTION_STRING: 'DefaultEndpointsProtocol=https;AccountName=${storage.name};AccountKey=${storage.listKeys().keys[0].value};EndpointSuffix=${environment().suffixes.storage}'
      LOCAL_DEVELOPMENT: 'false'
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
    } : {})
}

output appUrl string = 'https://${site.properties.defaultHostname}'
output staticSiteName string = site.name
output storageAccountName string = storage.name
