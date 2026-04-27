export const MODULE_ID = 'token-slurp';
export const FLAGS = {
  WILDCARD_PATH: 'wildcardPath',
  WILDCARD_ACTIVE: 'wildcardActive',
  // 'auto' | 'force' | 'lazy' — thumbnail generation option, auto generates if under 300 images
  THUMB_MODE: 'thumbMode',
  // Flag for randomizing placement from prototype token not canvas copy
  RANDOMIZED: 'randomized',
};

export const THUMB_MODES = {
  AUTO: 'auto',
  FORCE: 'force',
  LAZY: 'lazy',
};

export const THUMB_AUTO_THRESHOLD = 300;
export const THUMB_SIZE = 320;

// none is a fade with 0ms duration
export const ANIMATION_OPTIONS = [
  { value: 'none',       label: 'TOKEN_SLURP.animation.instant'   },
  { value: 'fade',       label: 'TOKEN_SLURP.animation.fade'       },
  { value: 'crosshatch', label: 'TOKEN_SLURP.animation.crosshatch' },
  { value: 'dots',       label: 'TOKEN_SLURP.animation.dots'       },
  { value: 'glitch',     label: 'TOKEN_SLURP.animation.glitch'     },
  { value: 'hole',       label: 'TOKEN_SLURP.animation.hole'       },
  { value: 'holeSwirl',  label: 'TOKEN_SLURP.animation.holeSwirl'  },
  { value: 'hologram',   label: 'TOKEN_SLURP.animation.hologram'   },
  { value: 'morph',      label: 'TOKEN_SLURP.animation.morph'      },
  { value: 'swirl',      label: 'TOKEN_SLURP.animation.swirl'      },
  { value: 'waterDrop',  label: 'TOKEN_SLURP.animation.waterDrop'  },
  { value: 'waves',      label: 'TOKEN_SLURP.animation.waves'      },
  { value: 'wind',       label: 'TOKEN_SLURP.animation.wind'       },
  { value: 'whiteNoise', label: 'TOKEN_SLURP.animation.whiteNoise' },
];