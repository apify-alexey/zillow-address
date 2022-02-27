const Apify = require('apify')

const { utils: { log } } = Apify

const { loadFileToDataset, restoreFullAddress, startExternalActor } = require('./src/routes')

Apify.main(async () => {
  const input = await Apify.getInput()

  const {
    startUrl,
    kvGeoStoreName,
    zestimateActorPath,
    dedupeActorPath = 'lukaskrivka/dedup-datasets',
    proxyConfig = { useApifyProxy: true },
    maxAddresses = 100,
    debug
  } = input

  if (debug) {
    log.setLevel(log.LEVELS.DEBUG)
  }

  const proxyConfiguration = await Apify.createProxyConfiguration(proxyConfig)

  const kvStore = await Apify.openKeyValueStore(kvGeoStoreName)
  const cityList = await kvStore.getValue('reverse-geocoding') || []

  let itemsToProcess = await loadFileToDataset(startUrl)
  itemsToProcess = await restoreFullAddress(cityList, itemsToProcess, proxyConfiguration)
  await kvStore.setValue('reverse-geocoding', cityList)

  if (!zestimateActorPath) {
    if (itemsToProcess?.length) {
      await Apify.setValue('itemsToProcess', itemsToProcess)
    }
    log.warning(`No zestimateActorPath, ${itemsToProcess?.length} raw items saved to KV of the current run`)
    return
  }

  while (itemsToProcess?.length) {
    const addressListInput = itemsToProcess.splice(0, maxAddresses || 100)
    log.debug(`Passing ${addressListInput.length} address items to external Zillow actor`)
    const dataFromActor = await startExternalActor(zestimateActorPath, addressListInput, input)
    if (dataFromActor) {
      // TODO dedupe by dedupeActorPath
      log.warning(`Skipping ${dedupeActorPath}`)
      await Apify.pushData(dataFromActor)
    }
  }
})
