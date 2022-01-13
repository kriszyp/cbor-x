import { Encoder } from '../index.js'
import assert from 'assert'

const small = [ 
	{ bn: '/3303/0/5700', bt: 1278887, v: 35.5 },{ t: 10, v: 34 },{ t: 20, v: 33 },{ t: 30, v: 32 },{ t: 40, v: 31 },{ t: 50, v: 30 } 
]

let large = []

for (let i = 0; i < 1000; i++) large.push({ t: 100+i, n: '1', vs: 'value-'+i } )

let senmlKeys = { bs: -6, bv: -5, bu: -4, bt: -3, bn: -2, n: 0, u: 1, v: 2, vs: 3, t: 6, ut: 7, vd: 8 }


function test(name, data, opts) { 
  let cbor = new Encoder(opts)
  let buff = cbor.encode(data)
  console.log(name, 'Buffer Size:', buff.length) 
  assert.deepEqual(cbor.decode(buff), data)
}

test('Basic no Recs (Small)', small, { useRecords: false})
test('Senml no Recs (Small)', small, { useREcords: false, keyMap: senmlKeys})

test('Basic wi Recs (Small)', small, { useRecords: true})
test('Senml wi Recs (Small)', small, { useRecords: true, keyMap: senmlKeys})

test('Basic no Recs (Large)', large, { useRecords: false})
test('Senml no Recs (Large)', large, { useRecords: false, keyMap: senmlKeys})

test('Basic wi Recs (Large)', large, { useRecords: true})
test('Senml wi Recs (Large)', large, { useRecords: true, keyMap: senmlKeys})


