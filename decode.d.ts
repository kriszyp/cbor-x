export enum FLOAT32_OPTIONS {
	NEVER = 0,
	ALWAYS = 1,
	DECIMAL_ROUND = 3,
	DECIMAL_FIT = 4
}

export interface Options {
	useFloat32?: FLOAT32_OPTIONS
	useRecords?: boolean
	structures?: {}[]
	structuredClone?: boolean
	mapsAsObjects?: boolean
	variableMapSize?: boolean
	copyBuffers?: boolean
	bundleStrings?: boolean
	useTimestamp32?: boolean
	largeBigIntToFloat?: boolean
	encodeUndefinedAsNil?: boolean
	maxSharedStructures?: number
	maxOwnStructures?: number
	useSelfDescribedHeader?: boolean
	shouldShareStructure?: (keys: string[]) => boolean
	getStructures?(): {}[]
	saveStructures?(structures: {}[]): boolean | void
	onInvalidDate?: () => any
}
interface Extension {
	Class: Function
	tag: number
	encode(value: any): Buffer | Uint8Array
	decode(messagePack: Buffer | Uint8Array): any
}
export class Decoder {
	constructor(options?: Options)
	decode(messagePack: Buffer | Uint8Array): any
	decodeMultiple(messagePack: Buffer | Uint8Array, forEach?: (value: any) => any): [] | void
}
export function decode(messagePack: Buffer | Uint8Array): any
export function decodeMultiple(messagePack: Buffer | Uint8Array, forEach?: (value: any) => any): [] | void
export function addExtension(extension: Extension): void
export function roundFloat32(float32Number: number): number
export let isNativeAccelerationEnabled: boolean

