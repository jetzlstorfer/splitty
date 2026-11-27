param location string
param functionAppName string

@description('Exact GitHub OIDC subject for the production environment. New repositories may include immutable owner and repository IDs.')
param subject string

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${functionAppName}-deploy'
  location: location
}

resource federation 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = {
  parent: identity
  name: 'github-environment'
  properties: {
    issuer: 'https://token.actions.githubusercontent.com'
    subject: subject
    audiences: ['api://AzureADTokenExchange']
  }
}

resource app 'Microsoft.Web/sites@2024-04-01' existing = {
  name: functionAppName
}

var websiteContributorRoleId = 'de139f84-1756-47ae-9be6-808fbbe84772'

resource deployer 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(app.id, identity.id, websiteContributorRoleId)
  scope: app
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', websiteContributorRoleId)
  }
}

output clientId string = identity.properties.clientId
output tenantId string = identity.properties.tenantId
output subscriptionId string = subscription().subscriptionId
