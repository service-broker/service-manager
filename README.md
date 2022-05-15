The service manager is itself a service provider, providing the "service-manager" service.  A request to the service manager should have two header fields, `method` and `args`, the latter being an object containing any required parameters.


### Manager API

| Method | Args | Description |
| ------ | ---- | ----------- |
| clientLogin | password | Clients must login before invoking any API |
| addSite | siteName, hostName, deployFolder, serviceBrokerUrl | Add a host site where services can be deployed |
| removeSite | siteName | Remove a site, must be empty (have no deployed services) |
| deployService | siteName, serviceName, repoUrl | Deploy a service to a site |
| undeployService | siteName, serviceName | Remove a deployed service |
| startService | siteName, serviceName | Start a service |
| stopService | siteName, serviceName | Send a shutdown request to a service |
| killService | siteName, serviceName | Kill a non-responsive service |
| viewServiceLogs | siteName, serviceName, lines | View the last n lines of stdout and stderr |
| setServiceStatus | siteName, serviceName, newStatus | Force update a service's status |
| updateService | siteName, serviceName | Run git pull && npm install |
| getServiceConf | siteName, serviceName | Retrieve the service's .env configuration entries as an object |
| updateServiceConf | siteName, serviceName, serviceConf | Update the service's .env file |
| addTopic | topicName, historySize | Monitor a topic, keeping a history of recent entries |
| removeTopic | topicName | Stop monitoring a topic |
| subscribeTopic | topicName | Subscribe to a monitored topic, receiving the history first, then new entries when they are published |
| unsubscribeTopic | topicName | Stop subscribing to a topic |


### Status Report API

| Method | Args | Description |
| ------ | ---- | ----------- |
| serviceCheckIn | siteName, serviceName, pid | A service calls this API to report that it's alive (it must provide its own PID, which must match what the SM expects) |
