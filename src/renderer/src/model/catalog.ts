import tissueColors from './assets/model20chan3cls/colormap.json'
import subcorticalColors from './assets/model30chan18cls/colormap.json'
import compactColors from './assets/model18cls/colormap.json'
import fiftyColors from './assets/model30chan50cls/colormap.json'
import oneHundredFourColors from './assets/model21_104class/colormap.json'

export type ModelAssetId =
  | 'hidden-light'
  | 'tissue-3'
  | 'subcortical-18'
  | 'compact-18'
  | 'aparc-50'
  | 'extract-3'
  | 'aparc-104'
  | 'mindgrab-2'

export type ModelGroupId =
  | 'tissue-gwm'
  | 'subcortical-gwm'
  | 'subcortical-fast'
  | 'aparc-50'
  | 'extract-mask'
  | 'aparc-104'
  | 'mindgrab'

export type ModelVariantId =
  | 'tissue-high'
  | 'tissue-low'
  | 'subcortical-high'
  | 'subcortical-low'
  | 'subcortical-failsafe'
  | 'subcortical-compact'
  | 'aparc-50-high'
  | 'aparc-50-low'
  | 'extract-high'
  | 'mask-high'
  | 'aparc-104-high'
  | 'aparc-104-low'
  | 'mindgrab-high'
  | 'mindgrab-low'

export type ModelNormalization = 'minmax' | 'quantile'
export type ModelExecution = 'high' | 'low'
export type ModelOutput = 'classes' | 'binary'

export interface ModelClassInfo {
  value: number
  name: string
  color: string
}

export interface ModelAssetSpec {
  id: ModelAssetId
  jsonHash: string
  weightsHash: string
  colorsHash: string | null
  colorClasses: number
  weightsBytes: number
  bundleBytes: number
  parameters: number
  layerCount: number
  convolutionCount: number
  hiddenFilters: number
  outputClasses: number
  weightSpecs: number
  dilations: readonly number[]
  activation: 'relu' | 'elu' | 'gelu'
  normalizedConvolutions: number
}

export interface ModelVariant {
  id: ModelVariantId
  groupId: ModelGroupId
  modeName: string
  assetId: ModelAssetId
  execution: ModelExecution
  normalization: ModelNormalization
  threshold: number
  padding: number
  prerequisite: 'hidden-light' | null
  output: ModelOutput
  binaryName: string | null
}

export interface ModelGroup {
  id: ModelGroupId
  name: string
  assetId: ModelAssetId
  preferredVariantId: ModelVariantId
  variantIds: readonly ModelVariantId[]
}

const STANDARD_DILATIONS = [1, 2, 4, 8, 16, 8, 4, 2, 1, 1] as const
const SHORT_DILATIONS = [1, 2, 4, 8, 4, 2, 2, 1, 1] as const
const ONE_HUNDRED_FOUR_DILATIONS = [1, 2, 2, 4, 4, 8, 8, 16, 1] as const
const MINDGRAB_DILATIONS = [
  16, 8, 4, 2, 1, 16, 8, 4, 2, 1, 16, 8, 4, 2, 1, 16, 8, 4, 2, 1, 16, 8, 4, 2, 1, 1
] as const

export const MODEL_ASSETS: Readonly<Record<ModelAssetId, ModelAssetSpec>> = {
  'hidden-light': {
    id: 'hidden-light',
    jsonHash: '7aabd59933bd3528f120107165f5dd577c5b749cf91fc2f949987d7bc620ce59',
    weightsHash: 'ca0d1b8ff72f8719d9525acaf9a1f1cb66dbb173b4ee1d7540f99e022cf4bfd8',
    colorsHash: null,
    colorClasses: 0,
    weightsBytes: 22_392,
    bundleBytes: 31_748,
    parameters: 5_598,
    layerCount: 20,
    convolutionCount: 10,
    hiddenFilters: 5,
    outputClasses: 3,
    weightSpecs: 20,
    dilations: STANDARD_DILATIONS,
    activation: 'relu',
    normalizedConvolutions: 0
  },
  'tissue-3': {
    id: 'tissue-3',
    jsonHash: '53932edad5330073bbac906049a31b84a2ca3d8c65d658feea848130004b984b',
    weightsHash: 'aecc03e3db596bfffab0ea1143f0848dbf4da4e317e04ef202986c6888cd467f',
    colorsHash: '71f3ce5c5d9d0db1208937f55fa35b9970ce63c1a24753cf74c471fe9a3c27eb',
    colorClasses: 3,
    weightsBytes: 348_732,
    bundleBytes: 377_629,
    parameters: 87_183,
    layerCount: 20,
    convolutionCount: 10,
    hiddenFilters: 20,
    outputClasses: 3,
    weightSpecs: 20,
    dilations: STANDARD_DILATIONS,
    activation: 'elu',
    normalizedConvolutions: 0
  },
  'subcortical-18': {
    id: 'subcortical-18',
    jsonHash: 'd28521c0965e452c371314e4b5b4dcef7b19aa91241b17ef894ac24952139701',
    weightsHash: '7039651d91c4cee0b7b1ddfe93fe2f5cb9b71d99f5a126fdef407e2a36bb52d4',
    colorsHash: '10ebff5980dd2afe1a1407dd951d1258dfc95fec51641bab9b4a9b88d76808c5',
    colorClasses: 18,
    weightsBytes: 784_152,
    bundleBytes: 812_790,
    parameters: 196_038,
    layerCount: 20,
    convolutionCount: 10,
    hiddenFilters: 30,
    outputClasses: 18,
    weightSpecs: 20,
    dilations: STANDARD_DILATIONS,
    activation: 'elu',
    normalizedConvolutions: 0
  },
  'compact-18': {
    id: 'compact-18',
    jsonHash: '57346ac8b66ebe8d92296b1cf9988143be4949b6ef9695a790ef3d7fba3fb81b',
    weightsHash: '725096439f64ece1ca45ec3c5115c9fa6004f6538cac3032b85966d3772b605e',
    colorsHash: '10ebff5980dd2afe1a1407dd951d1258dfc95fec51641bab9b4a9b88d76808c5',
    colorClasses: 18,
    weightsBytes: 385_632,
    bundleBytes: 414_270,
    parameters: 96_408,
    layerCount: 20,
    convolutionCount: 10,
    hiddenFilters: 21,
    outputClasses: 18,
    weightSpecs: 20,
    dilations: STANDARD_DILATIONS,
    activation: 'elu',
    normalizedConvolutions: 0
  },
  'aparc-50': {
    id: 'aparc-50',
    jsonHash: '105db3a77c49fb3e7d59c6e9506981e13223b76dcd4c4b407640d422409e5353',
    weightsHash: 'a7e597568dc7750c64cce8c64c4ca3ec7215716949efd741f19904da1baffa81',
    colorsHash: '3895b0c40b1ef299bda68ac79bce6f1bbbb6e28d9dd990ef121402c08bc34645',
    colorClasses: 50,
    weightsBytes: 788_120,
    bundleBytes: 817_021,
    parameters: 197_030,
    layerCount: 20,
    convolutionCount: 10,
    hiddenFilters: 30,
    outputClasses: 50,
    weightSpecs: 20,
    dilations: STANDARD_DILATIONS,
    activation: 'elu',
    normalizedConvolutions: 0
  },
  'extract-3': {
    id: 'extract-3',
    jsonHash: '09d1afa152a907a545ce814842613559fbfe2bfdaab0bc8708ea79cd3e17229c',
    weightsHash: '7f93edb82252cdc59e3faf3ae5a27622bc748d02db64df2cf429ad807891c261',
    colorsHash: '36a45c1cc84ccb73482f3ad5a4d482da1f965e55c4b59f8f18d3649a8e7fd94d',
    colorClasses: 2,
    weightsBytes: 93_160,
    bundleBytes: 102_214,
    parameters: 23_290,
    layerCount: 18,
    convolutionCount: 9,
    hiddenFilters: 11,
    outputClasses: 3,
    weightSpecs: 18,
    dilations: SHORT_DILATIONS,
    activation: 'relu',
    normalizedConvolutions: 0
  },
  'aparc-104': {
    id: 'aparc-104',
    jsonHash: 'b80a9ac7dccaecc08d59a7f2285a1dce50305d317f505b437518773ab2b27446',
    weightsHash: '8a0aa1e2d94e5edc94c54aed900da978d2a1388bee4621cee05e473db64b84af',
    colorsHash: 'a450db760609a91a38b3ff1810a465841c39b1ff138cab005071c897ad0da069',
    colorClasses: 104,
    weightsBytes: 345_488,
    bundleBytes: 353_992,
    parameters: 86_372,
    layerCount: 18,
    convolutionCount: 9,
    hiddenFilters: 21,
    outputClasses: 104,
    weightSpecs: 18,
    dilations: ONE_HUNDRED_FOUR_DILATIONS,
    activation: 'relu',
    normalizedConvolutions: 0
  },
  'mindgrab-2': {
    id: 'mindgrab-2',
    jsonHash: '24d1bcccba736a83c80b336ca349297f4839ae08b8ec92ec72c5d6adb9afe76e',
    weightsHash: 'c9a01490fe2d13acc1515fd019b69db176ebe6f40c9b84aeb77f25acbc2ee0f3',
    colorsHash: 'b29809105747c752c889036bb953744cbd63b67f25b9c1b0657eaf00841fd1bf',
    colorClasses: 2,
    weightsBytes: 584_948,
    bundleBytes: 653_279,
    parameters: 146_237,
    layerCount: 52,
    convolutionCount: 26,
    hiddenFilters: 15,
    outputClasses: 2,
    weightSpecs: 27,
    dilations: MINDGRAB_DILATIONS,
    activation: 'gelu',
    normalizedConvolutions: 25
  }
}

export const MODEL_VARIANTS: readonly ModelVariant[] = [
  {
    id: 'tissue-high',
    groupId: 'tissue-gwm',
    modeName: 'High Mem / Fast',
    assetId: 'tissue-3',
    execution: 'high',
    normalization: 'quantile',
    threshold: 0.2,
    padding: 0,
    prerequisite: null,
    output: 'classes',
    binaryName: null
  },
  {
    id: 'tissue-low',
    groupId: 'tissue-gwm',
    modeName: 'Low Mem / Slow',
    assetId: 'tissue-3',
    execution: 'low',
    normalization: 'quantile',
    threshold: 0.2,
    padding: 0,
    prerequisite: null,
    output: 'classes',
    binaryName: null
  },
  {
    id: 'subcortical-high',
    groupId: 'subcortical-gwm',
    modeName: 'High Mem / Fast',
    assetId: 'subcortical-18',
    execution: 'high',
    normalization: 'minmax',
    threshold: 0.2,
    padding: 0,
    prerequisite: null,
    output: 'classes',
    binaryName: null
  },
  {
    id: 'subcortical-low',
    groupId: 'subcortical-gwm',
    modeName: 'Low Mem / Slow',
    assetId: 'subcortical-18',
    execution: 'low',
    normalization: 'minmax',
    threshold: 0.2,
    padding: 0,
    prerequisite: null,
    output: 'classes',
    binaryName: null
  },
  {
    id: 'subcortical-failsafe',
    groupId: 'subcortical-gwm',
    modeName: 'Failsafe / Less Acc',
    assetId: 'subcortical-18',
    execution: 'high',
    normalization: 'minmax',
    threshold: 0,
    padding: 0,
    prerequisite: 'hidden-light',
    output: 'classes',
    binaryName: null
  },
  {
    id: 'subcortical-compact',
    groupId: 'subcortical-fast',
    modeName: 'Low Mem / Faster',
    assetId: 'compact-18',
    execution: 'low',
    normalization: 'minmax',
    threshold: 0.2,
    padding: 0,
    prerequisite: null,
    output: 'classes',
    binaryName: null
  },
  {
    id: 'aparc-50-high',
    groupId: 'aparc-50',
    modeName: 'High Mem / Fast',
    assetId: 'aparc-50',
    execution: 'high',
    normalization: 'quantile',
    threshold: 0,
    padding: 0,
    prerequisite: 'hidden-light',
    output: 'classes',
    binaryName: null
  },
  {
    id: 'aparc-50-low',
    groupId: 'aparc-50',
    modeName: 'Low Mem / Slow',
    assetId: 'aparc-50',
    execution: 'low',
    normalization: 'quantile',
    threshold: 0,
    padding: 0,
    prerequisite: 'hidden-light',
    output: 'classes',
    binaryName: null
  },
  {
    id: 'extract-high',
    groupId: 'extract-mask',
    modeName: 'Extract',
    assetId: 'extract-3',
    execution: 'low',
    normalization: 'minmax',
    threshold: 0,
    padding: 0,
    prerequisite: null,
    output: 'binary',
    binaryName: 'Extracted Brain'
  },
  {
    id: 'mask-high',
    groupId: 'extract-mask',
    modeName: 'Brain Mask',
    assetId: 'extract-3',
    execution: 'low',
    normalization: 'quantile',
    threshold: 0,
    padding: 0,
    prerequisite: null,
    output: 'binary',
    binaryName: 'Brain Mask'
  },
  {
    id: 'aparc-104-high',
    groupId: 'aparc-104',
    modeName: 'High Mem / Fast',
    assetId: 'aparc-104',
    execution: 'high',
    normalization: 'minmax',
    threshold: 0,
    padding: 0,
    prerequisite: 'hidden-light',
    output: 'classes',
    binaryName: null
  },
  {
    id: 'aparc-104-low',
    groupId: 'aparc-104',
    modeName: 'Low Mem / Slow',
    assetId: 'aparc-104',
    execution: 'low',
    normalization: 'minmax',
    threshold: 0,
    padding: 0,
    prerequisite: null,
    output: 'classes',
    binaryName: null
  },
  {
    id: 'mindgrab-high',
    groupId: 'mindgrab',
    modeName: 'High Mem / Fast',
    assetId: 'mindgrab-2',
    execution: 'high',
    normalization: 'minmax',
    threshold: 0.5,
    padding: 20,
    prerequisite: null,
    output: 'binary',
    binaryName: 'MindGrab Mask'
  },
  {
    id: 'mindgrab-low',
    groupId: 'mindgrab',
    modeName: 'Low Mem / Slow',
    assetId: 'mindgrab-2',
    execution: 'low',
    normalization: 'minmax',
    threshold: 0.5,
    padding: 20,
    prerequisite: null,
    output: 'binary',
    binaryName: 'MindGrab Mask'
  }
]

export const MODEL_GROUPS: readonly ModelGroup[] = [
  {
    id: 'tissue-gwm',
    name: 'Tissue GWM (High Acc)',
    assetId: 'tissue-3',
    preferredVariantId: 'tissue-high',
    variantIds: ['tissue-high', 'tissue-low']
  },
  {
    id: 'subcortical-gwm',
    name: 'Subcortical + GWM',
    assetId: 'subcortical-18',
    preferredVariantId: 'subcortical-high',
    variantIds: ['subcortical-high', 'subcortical-low', 'subcortical-failsafe']
  },
  {
    id: 'subcortical-fast',
    name: 'Subcortical + GWM (Faster)',
    assetId: 'compact-18',
    preferredVariantId: 'subcortical-compact',
    variantIds: ['subcortical-compact']
  },
  {
    id: 'aparc-50',
    name: 'Aparc+Aseg 50',
    assetId: 'aparc-50',
    preferredVariantId: 'aparc-50-high',
    variantIds: ['aparc-50-high', 'aparc-50-low']
  },
  {
    id: 'extract-mask',
    name: 'Extract / Brain Mask (High Acc)',
    assetId: 'extract-3',
    preferredVariantId: 'extract-high',
    variantIds: ['extract-high', 'mask-high']
  },
  {
    id: 'aparc-104',
    name: 'Aparc+Aseg 104',
    assetId: 'aparc-104',
    preferredVariantId: 'aparc-104-high',
    variantIds: ['aparc-104-high', 'aparc-104-low']
  },
  {
    id: 'mindgrab',
    name: 'Omnimodal Skull Strip / MindGrab',
    assetId: 'mindgrab-2',
    preferredVariantId: 'mindgrab-high',
    variantIds: ['mindgrab-high', 'mindgrab-low']
  }
]

export const DEFAULT_MODEL_VARIANT_ID: ModelVariantId = 'tissue-high'

const variantsById = new Map(MODEL_VARIANTS.map((variant) => [variant.id, variant]))
const groupsById = new Map(MODEL_GROUPS.map((group) => [group.id, group]))

function hex(value: number): string {
  return value.toString(16).padStart(2, '0')
}

function colorClasses(table: {
  R: number[]
  G: number[]
  B: number[]
  labels: string[]
}): ModelClassInfo[] {
  return table.labels.map((name, value) => ({
    value,
    name,
    color: `#${hex(table.R[value])}${hex(table.G[value])}${hex(table.B[value])}`
  }))
}

const classesByAsset: Readonly<Partial<Record<ModelAssetId, readonly ModelClassInfo[]>>> = {
  'tissue-3': colorClasses(tissueColors),
  'subcortical-18': colorClasses(subcorticalColors),
  'compact-18': colorClasses(compactColors),
  'aparc-50': colorClasses(fiftyColors),
  'aparc-104': colorClasses(oneHundredFourColors)
}

export function modelVariant(id: ModelVariantId): ModelVariant {
  const variant = variantsById.get(id)
  if (!variant) throw new Error('Unknown model variant.')
  return variant
}

export function modelGroup(id: ModelGroupId): ModelGroup {
  const group = groupsById.get(id)
  if (!group) throw new Error('Unknown model group.')
  return group
}

export function modelClasses(variantId: ModelVariantId): readonly ModelClassInfo[] {
  const variant = modelVariant(variantId)
  if (variant.output === 'binary') {
    const color = variant.assetId === 'mindgrab-2' ? '#ffffff' : '#ff0000'
    return [
      { value: 0, name: 'background', color: '#000000' },
      { value: 1, name: variant.binaryName ?? 'Mask', color }
    ]
  }
  const classes = classesByAsset[variant.assetId]
  if (!classes) throw new Error('Model class metadata is unavailable.')
  return classes
}

export function variantsForGroup(groupId: ModelGroupId): readonly ModelVariant[] {
  return modelGroup(groupId).variantIds.map(modelVariant)
}

export function lowMemoryAlternative(variantId: ModelVariantId): ModelVariant | null {
  const variant = modelVariant(variantId)
  if (variant.execution !== 'high') return null
  return (
    variantsForGroup(variant.groupId).find((candidate) => candidate.execution === 'low') ?? null
  )
}
