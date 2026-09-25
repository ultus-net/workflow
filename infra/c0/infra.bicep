// C0 phase 1: long-lived plane infrastructure — VNet, workload-profiles
// environment, ACR, deployer identity + acrpull. The container app itself is
// app.bicep so image push can land between the two deployments.
param location string = 'australiaeast'
param acrName string = 'wfdevplane${uniqueString(resourceGroup().id)}'

var acrPullRoleDefinitionId = '7f951dda-4ed3-4680-a7ca-43fe172d538d' // AcrPull (verified via az role definition list)

resource vnet 'Microsoft.Network/virtualNetworks@2024-01-01' = {
  name: 'workflow-dev-vnet'
  location: location
  properties: {
    addressSpace: {
      addressPrefixes: ['10.99.0.0/24']
    }
    subnets: [
      {
        name: 'infrastructure'
        properties: {
          addressPrefix: '10.99.0.0/27'
          delegations: [
            {
              name: 'containerapps-delegation'
              properties: {
                serviceName: 'Microsoft.App/environments'
              }
            }
          ]
        }
      }
      {
        name: 'reserve-endpoints'
        properties: {
          addressPrefix: '10.99.0.32/27'
        }
      }
    ]
  }
}

resource planeIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'workflow-dev-plane-identity'
  location: location
}

resource acr 'Microsoft.ContainerRegistry/registries@2023-06-01-preview' = {
  name: acrName
  location: location
  sku: {
    name: 'Standard'
  }
  properties: {
    adminUserEnabled: false
    publicNetworkAccess: 'Enabled'
  }
}

resource acrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(acr.id, planeIdentity.id, 'acrpull')
  scope: acr
  properties: {
    roleDefinitionId: acrPullRoleDefinitionId
    principalId: planeIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource env 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: 'workflow-dev-env'
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'none'
    }
    vnetConfiguration: {
      internal: false
      infrastructureSubnetId: vnet.properties.subnets[0].id
    }
    workloadProfiles: [
      {
        name: 'Consumption'
        workloadProfileType: 'Consumption'
      }
    ]
    zoneRedundant: false
  }
}

output acrName string = acr.name
output acrLoginServer string = acr.properties.loginServer
output environmentId string = env.id
output identityId string = planeIdentity.id
output vnetName string = vnet.name
