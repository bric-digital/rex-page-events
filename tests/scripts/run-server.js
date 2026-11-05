import { gunzipSync } from 'node:zlib';
import { Buffer } from 'node:buffer';

import express from 'express'

const app = express();
const port = 9090;

app.get('/', (request, response) => {
  response.send('The only way to pass a test is to take the test. <div id="rex_here">NO</div>')
})

app.listen(port, () => {
  console.log(`Server running on port ${port}...`);
})
