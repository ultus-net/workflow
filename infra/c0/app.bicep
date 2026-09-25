// C0 phase 2: the transport-probe container app — stock opencode serve only.
// Pinned C0 recipe: external ingress, HTTP/1.1 transport (SSE chunked),
// session affinity, minReplicas 1 (always-on posture, spec §10).
param location string = 'australiaeast'
param environmentId string
param identityId string
param acrLoginServer string
@secure()
param opencodeServerPassword string
param imageTag string = 'c0'

var appName = 'workflow-dev-cplane'

resource app 'Microsoft.App/containerApps@2024-03-01' = {
  name: appName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identityId}': {}
    }
  }
  properties: {
    managedEnvironmentId: environmentId
    configuration: {
      secrets: [
        {
          name: 'opencode-server-password'
          value: opencodeServerPassword
        }
      ]
      registries: [
        {
          server: acrLoginServer
          identity: identityId
        }
      ]
      ingress: {
        external: true
        targetPort: 4096
        transport: 'http'
        allowInsecure: false
      }
    }
    template: {
      containers: [
        {
          name: 'opencode-serve'
          image: '${acrLoginServer}/opencode-plane:${imageTag}'
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          env: [
            {
              name: 'OPENCODE_SERVER_PASSWORD'
              secretRef: 'opencode-server-password'
            }
            {
              name: 'OPENCODE_DISABLE_AUTOUPDATE'
              value: '1'
            }
          ]
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 1
      }
    }
  }
}

output fqdn string = app.properties.configuration.ingress.fqdn
output appName string = appName
