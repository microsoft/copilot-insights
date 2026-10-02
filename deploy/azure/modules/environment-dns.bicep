// Private DNS for the internal Container Apps environment. A module because the zone name is only known after
// the environment is created.
param zoneName string
param staticIp string
param virtualNetworkIds array

resource zone 'Microsoft.Network/privateDnsZones@2024-06-01' = {
  name: zoneName
  location: 'global'
}

resource wildcardRecord 'Microsoft.Network/privateDnsZones/A@2024-06-01' = {
  parent: zone
  name: '*'
  properties: {
    ttl: 300
    aRecords: [{ ipv4Address: staticIp }]
  }
}

resource apexRecord 'Microsoft.Network/privateDnsZones/A@2024-06-01' = {
  parent: zone
  name: '@'
  properties: {
    ttl: 300
    aRecords: [{ ipv4Address: staticIp }]
  }
}

resource links 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = [for id in virtualNetworkIds: {
  parent: zone
  name: 'link-${uniqueString(id)}'
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: { id: id }
  }
}]
