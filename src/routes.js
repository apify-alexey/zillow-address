const Apify = require('apify')

const { utils: { log, requestAsBrowser, sleep } } = Apify

// remote file expected to be PRECISELY in custom format:
// collection of lines, each line is geojson pont
// {"type":"Feature","properties":{"hash":"6ccb71df2a08e475","number":"155","street":"BATTERY PARK DR","unit":"","city":"","district":"","region":"","postcode":"","id":""},"geometry":{"type":"Point","coordinates":[-73.2277281,41.1436111]}}
// failing to parse it means we should not continue since data source is corrupted (therefore actor must fail)
exports.loadFileToDataset = async (url) => {
  log.info(`Getting geojson Points from ${url}`)

  const fileRequest = await requestAsBrowser({ url })
  const valueCounters = {}
  const lines = fileRequest.body.split(/\r?\n/)
    .map(x => {
      if (!x) {
        return null
      }
      const partialJsonData = JSON.parse(x)
      const properties = partialJsonData?.properties || {}
      // count cases when we have value per key
      Object.keys(properties).forEach(valueName => {
        if (valueCounters[valueName] === undefined) {
          valueCounters[valueName] = 0
        }
        if (properties[valueName]) {
          valueCounters[valueName] = valueCounters[valueName] + 1
        }
      })
      return partialJsonData
    })
    .filter(x => x && x?.geometry?.type?.toLowerCase() === 'point' && x?.geometry?.coordinates)

  if (!lines?.length) {
    log.warning(`File from ${url} have no geojson points`)
    return
  };

  const parsingStats = { ...valueCounters, dataLines: lines?.length }
  await Apify.setValue('parsingStats', parsingStats)
  log.info(`${url} processed`, parsingStats)
  return lines
}

const matchBoundingBox = (cityItem, coord) => {
  /*
    "boundingbox":["41.1399013","41.2296213","-73.2440717","-73.1537198"]
    "coordinates": [
        -73.2277281,
        41.1436111
      ]
    */
  const box = cityItem.boundingbox
  return box[0] <= coord[1] && box[1] >= coord[1] && box[2] <= coord[0] && box[3] >= coord[0]
}

exports.restoreFullAddress = async (cityList, dataArray, proxyConfiguration) => {
  const normalizedAddressList = []
  for (const geoItem of dataArray) {
    const {
      properties,
      geometry
    } = geoItem

    const {
      number,
      street,
      city,
      region,
      postcode
    } = properties

    // check if we can compose full zillow address like
    // 155 Battery Park Dr, Bridgeport, CT 06605
    if (number && street && city && region && postcode) {
      normalizedAddressList.push(`${number} ${street}, ${city}, ${region} ${postcode}`)
      continue
    }

    // if there is no number and street we can not restore address
    if (!(number && street)) {
      log.warning('Unable to process geojson item', geoItem)
      continue
    }

    const {
      coordinates
    } = geometry

    const checkupCity = cityList.find(x => matchBoundingBox(x, coordinates))

    if (checkupCity) {
      normalizedAddressList.push(`${number} ${street}, ${checkupCity.display_name}`)
      continue
    }

    const proxyUrl = await proxyConfiguration.newUrl()
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${coordinates[1]}&lon=${coordinates[0]}&zoom=10&format=jsonv2`
    const cityJson = await requestAsBrowser({ url, proxyUrl, responseType: 'json' })
    await sleep(3000)
    if (!cityJson?.body?.boundingbox) {
      log.warning('Unable to reverse', { coordinates })
      continue
    }
    cityList.push(cityJson.body)
    log.debug(`Mapped city ${cityJson.body.display_name}`)
    normalizedAddressList.push(`${number} ${street}, ${cityJson.displayName}`)
  }

  return normalizedAddressList
}

exports.startExternalActor = async (actorName, addresses, input) => {
  const callOptions = {
    addresses,
    proxy: input?.proxyConfigurationConfig || { useApifyProxy: true }
  }

  log.info(`Starting External run of ${actorName} for ${addresses?.length} addresses`)
  const actorRun = await Apify.call(actorName, callOptions)

  if (!(actorRun && actorRun.status === 'SUCCEEDED')) {
    log.error('handleExternalActorFailed', actorRun)
    return
  }

  const externalDataset = await Apify.openDataset(actorRun.defaultDatasetId, { forceCloud: true })
  const data = await externalDataset.getData()

  if (!data?.items?.length) {
    log.warning(`No data output from ${actorName}`, actorRun)
    return
  }

  await Apify.pushData(data.items)
}
