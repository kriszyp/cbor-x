import { Decoder } from './decode'
export { addExtension, FLOAT32_OPTIONS } from './unpack'
export class Encoder extends Decoder {
	encode(value: any): Buffer
}
export function encode(value: any): Buffer
