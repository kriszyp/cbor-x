import * as CBOR from '../node-index.js'
import chai from 'chai'
var assert = chai.assert
var Encoder = CBOR.Encoder

const data = {
	z: 3,
	y: 2,
	x: 1,
	"1111": 4,
}

suite('CBOR canonicalization', function(){
	test('encode with sorted maps', function() {
		let cbor = new Encoder({
			useRecords: false,
			mapsAsObjects: false,
			variableMapSize: true,
			sortMaps: true,
		})
		let serialized = bytesToHex(cbor.encode(data))
		console.log("encoded:", serialized)

		const want = "a4617801617902617a03643131313104"
		assert.equal(serialized, want)
	})
})

function bytesToHex(bytes) {
	return Array.from(bytes)
	  .map(b => b.toString(16).padStart(2, '0'))
	  .join('')
}
