import type { AceCatalog } from '../../src/construct3/ace-types.js';

/**
 * The catalogue that buildCatalog produces from the hand-written source
 * folder test/fixtures/ace-source/r495-2. It holds only the entries tests
 * name, written from scratch; it is not an excerpt of any editor file.
 */
export const TEST_CATALOG: AceCatalog = {
  release: 'r495-2',
  plugins: {
    Audio: {
      conditions: {},
      actions: {
        play: [
          { id: 'audio-file', type: 'audiofile' },
          { id: 'loop', type: 'combo', items: ['not-looping', 'looping'] },
          { id: 'volume', type: 'number' },
          { id: 'tag', type: 'string' },
        ],
      },
      expressions: {},
    },
    Function: {
      conditions: {},
      actions: {},
      expressions: {
        param: { name: 'Param', params: ['number'], returns: 'any' },
        paramcount: { name: 'ParamCount', params: [], returns: 'number' },
      },
    },
    Sprite: {
      conditions: {},
      actions: {
        'set-animation': [
          { id: 'animation', type: 'string' },
          { id: 'from', type: 'combo', items: ['current-frame', 'beginning'] },
        ],
      },
      expressions: {
        animationname: { name: 'AnimationName', params: [], returns: 'string' },
        imagepointx: { name: 'ImagePointX', params: ['string'], returns: 'number' },
      },
    },
    system: {
      conditions: {
        'on-start-of-layout': [],
        'compare-two-values': [
          { id: 'first-value', type: 'any' },
          { id: 'comparison', type: 'cmp' },
          { id: 'second-value', type: 'any' },
        ],
      },
      actions: {
        'set-eventvar-value': [
          { id: 'variable', type: 'eventvar' },
          { id: 'value', type: 'any' },
        ],
      },
      expressions: {
        choose: { name: 'choose', params: ['any', 'any'], variadic: true, returns: 'any' },
        int: { name: 'int', params: ['any'], returns: 'number' },
        random: { name: 'random', params: ['number'], variadic: true, returns: 'number' },
        distance: { name: 'distance', params: ['number', 'number', 'number', 'number'], returns: 'number' },
        max: { name: 'max', params: ['number', 'number'], variadic: true, returns: 'number' },
        loopindex: { name: 'loopindex', params: [], variadic: true, returns: 'number' },
        dt: { name: 'dt', params: [], returns: 'number' },
        pi: { name: 'pi', params: [], returns: 'number' },
        layoutname: { name: 'LayoutName', params: [], returns: 'string' },
        callmapped: { name: 'CallMapped', params: ['string'], variadic: true, returns: 'any' },
      },
    },
  },
  behaviors: {
    Platform: {
      conditions: { 'is-on-floor': [] },
      actions: {
        'simulate-control': [
          { id: 'control', type: 'combo', items: ['left', 'right', 'jump'] },
        ],
      },
      expressions: {
        VectorX: { name: 'VectorX', params: [], returns: 'number' },
      },
    },
  },
  common: {
    conditions: {
      'compare-instance-variable': [
        { id: 'instance-variable', type: 'instancevar' },
        { id: 'comparison', type: 'cmp' },
        { id: 'value', type: 'any' },
      ],
    },
    actions: {
      'set-instvar-value': [
        { id: 'instance-variable', type: 'instancevar' },
        { id: 'value', type: 'any' },
      ],
      'set-x': [{ id: 'x', type: 'number' }],
      'set-position': [
        { id: 'x', type: 'number' },
        { id: 'y', type: 'number' },
      ],
    },
    expressions: {
      uid: { name: 'UID', params: [], returns: 'number' },
      x: { name: 'X', params: [], returns: 'number' },
      y: { name: 'Y', params: [], returns: 'number' },
      width: { name: 'Width', params: [], returns: 'number' },
      pickedcount: { name: 'PickedCount', params: [], returns: 'number' },
    },
  },
};
