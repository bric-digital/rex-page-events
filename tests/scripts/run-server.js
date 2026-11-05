import express from 'express'

import path from 'path'

const app = express();
const port = 9090;

app.use(express.static(path.join(import.meta.dirname, 'pages')))

app.get('/', (request, response) => {
  response.send('Don\'t delete me or Playwright gets confused.')
})


app.listen(port, () => {
  console.log(`Server running on port ${port}...`)
})
