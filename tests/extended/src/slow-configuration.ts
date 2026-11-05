// @ts-nocheck

const DELAY_KEY = 'testConfigurationReadDelayMs'
const CONFIGURATION_KEY = 'REXConfiguration'

const readLocal = chrome.storage.local.get.bind(chrome.storage.local)

function pause(ms) {
  return new Promise((resolve) => self.setTimeout(resolve, ms))
}

chrome.storage.local.get = (keys, ...rest) => {
  if (keys !== CONFIGURATION_KEY || rest.length > 0) {
    return readLocal(keys, ...rest)
  }

  return chrome.storage.session.get(DELAY_KEY)
    .then((saved) => pause(saved[DELAY_KEY] ?? 0))
    .then(() => readLocal(keys))
}
