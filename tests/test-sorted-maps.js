import * as CBOR from '../node-index.js'
import chai from 'chai'
var assert = chai.assert
var Encoder = CBOR.Encoder


const options = {
	useRecords: false,
	mapsAsObjects: false,
	variableMapSize: true,
	sortMaps: true,
}

const want = "a5617801617902617a036361616104643131313105"

suite('CBOR canonicalization', function(){
	test('encode with sorted objects', function() {
		let cbor = new Encoder(options)
		const obj = {
			z: 3,
			y: 2,
			x: 1,
			"1111": 5,
			"aaa": 4,
		}
		let serialized = bytesToHex(cbor.encode(obj))
		assert.equal(serialized, want)
	})

	test("encode map with sorted keys", function() {
		options.useTag259ForMaps = false
		let cbor = new Encoder(options)

		const map = new Map([
			["z", 3],
			["y", 2],
			["x", 1],
			["1111", 5],
			["aaa", 4],
		])
		let serialized = bytesToHex(cbor.encode(map))
		assert.equal(serialized, want)
	})
})

function bytesToHex(bytes) {
	return Array.from(bytes)
	  .map(b => b.toString(16).padStart(2, '0'))
	  .join('')
}
