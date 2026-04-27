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

// Animation options
export const ANIMATION_OPTIONS = [
  { value: 'none',  label: 'TOKEN_SLURP.animation.none'  },
  { value: 'fade',  label: 'TOKEN_SLURP.animation.fade'  },
  { value: 'swirl', label: 'TOKEN_SLURP.animation.swirl' },
  { value: 'dots',  label: 'TOKEN_SLURP.animation.dots'  },
];
