/*! @license
 * Shaka Player
 * Copyright 2016 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

goog.provide('shaka.abr.LlAbrManager');
goog.require('shaka.log');
goog.require('shaka.util.EventManager');
goog.require('shaka.util.IReleasable');
goog.require('shaka.util.Timer');


/**
 * Buffer-based ABR manager for low-latency MoQ/MSF streams.
 *
 * Down-switch: immediate on low buffer or excessive dropped frames.
 * Up-switch: requires 5 seconds of sustained healthy buffer.
 * Thresholds are relative to targetLatency (default 2000ms).
 *
 * @implements {shaka.extern.AbrManager}
 * @implements {shaka.util.IReleasable}
 * @export
 */
shaka.abr.LlAbrManager = class {
  constructor() {
    /** @private {?shaka.extern.AbrManager.SwitchCallback} */
    this.switch_ = null;

    /** @private {!shaka.util.EventManager} */
    this.eventManager_ = new shaka.util.EventManager();

    /** @private {HTMLMediaElement} */
    this.mediaElement_ = null;

    /** @private {!Array<!shaka.extern.Variant>} */
    this.variants_ = [];

    /** @private {shaka.util.Timer} */
    this.timer_ = new shaka.util.Timer(() => this.evaluate_());

    // ABR state
    /** @private {!Array<{variant: shaka.extern.Variant, pixels: number, width: number, height: number, bandwidth: number}>} */
    this.ladder_ = [];

    /** @private {number} */
    this.currentIndex_ = -1;

    /** @private {number} */
    this.switchCount_ = 0;

    /** @private {string} */
    this.state_ = 'stable';

    /** @private {number} */
    this.stableStart_ = 0;

    /** @private {number} */
    this.lastDroppedFrames_ = 0;

    /** @private {number} */
    this.playbackStartTime_ = 0;

    /** @private {boolean} */
    this.enabled_ = false;

    /** @private {number} */
    this.targetLatency_ = 2000;
  }


  /**
   * @override
   * @export
   */
  stop() {
    this.switch_ = null;
    this.variants_ = [];
    this.enabled_ = false;
    if (this.timer_) {
      this.timer_.stop();
    }
  }

  /**
   * @override
   * @export
   */
  release() {
    this.stop();
    this.eventManager_.release();
  }


  /**
   * @override
   * @export
   */
  init(switchCallback) {
    this.switch_ = switchCallback;
  }


  /**
   * @param {boolean=} preferFastSwitching
   * @return {shaka.extern.Variant}
   * @override
   * @export
   */
  chooseVariant(preferFastSwitching = false) {
    // Baby step: simplest possible — return first variant
    const chosen = this.variants_[0] || null;
    return chosen;
  }


  /**
   * @override
   * @export
   */
  trySuggestStreams() {
  }

  /**
   * @override
   * @export
   */
  enable() {
    if (this.enabled_) {
      return;
    }
    this.enabled_ = true;
    this.playbackStartTime_ = Date.now();
    this.state_ = 'stable';
    this.stableStart_ = Date.now();
    this.lastDroppedFrames_ = 0;

    // Disabled for baby step testing
    // if (this.ladder_.length > 1) {
    //   this.timer_.tickEvery(1);
    // }
  }


  /**
   * @override
   * @export
   */
  disable() {
    this.enabled_ = false;
    if (this.timer_) {
      this.timer_.stop();
    }
  }


  /**
   * @override
   * @export
   */
  segmentDownloaded(deltaTimeMs, numBytes, allowSwitch, request, context) {
  }


  /**
   * @override
   * @export
   */
  getBandwidthEstimate() {
    return 0;
  }


  /**
   * @override
   * @export
   */
  setVariants(variants) {
    this.variants_ = variants;
    this.buildLadder_();
    return true;
  }


  /**
   * @override
   * @export
   */
  playbackRateChanged(rate) {
  }


  /**
   * @override
   * @export
   */
  setMediaElement(mediaElement) {
    this.mediaElement_ = mediaElement;
  }


  /**
   * @override
   * @export
   */
  setCmsdManager(cmsdManager) {
  }


  /**
   * @override
   * @export
   */
  configure(config) {
  }

  /**
   * Build ABR ladder from variants, sorted by pixel count ascending.
   * @private
   */
  buildLadder_() {
    const seen = new Map();
    for (const v of this.variants_) {
      if (!v.video) {
        continue;
      }
      const w = v.video.width || 0;
      const h = v.video.height || 0;
      const pixels = w * h;
      if (pixels === 0) {
        continue;
      }
      const key = w + 'x' + h;
      if (!seen.has(key) || v.bandwidth > (seen.get(key).bandwidth || 0)) {
        seen.set(key, {
          variant: v,
          pixels: pixels,
          width: w,
          height: h,
          bandwidth: v.bandwidth || 0,
        });
      }
    }
    this.ladder_ = Array.from(seen.values()).sort((a, b) => a.pixels - b.pixels);
  }

  /**
   * Evaluate buffer health and switch quality if needed.
   * @private
   */
  evaluate_() {
    if (!this.enabled_ || !this.mediaElement_ || this.ladder_.length <= 1) {
      return;
    }

    // Grace period: skip first 5s after enable
    if (Date.now() - this.playbackStartTime_ < 5000) {
      return;
    }

    const video = this.mediaElement_;
    const buffered = video.buffered;
    if (buffered.length === 0) {
      return;
    }

    const bufferHealth =
        buffered.end(buffered.length - 1) - video.currentTime;
    if (bufferHealth <= 0) {
      return;
    }

    const htmlVideo = /** @type {HTMLVideoElement} */ (video);
    const dropped = htmlVideo.getVideoPlaybackQuality ?
        htmlVideo.getVideoPlaybackQuality().droppedVideoFrames : 0;
    const droppedDelta = dropped - this.lastDroppedFrames_;
    this.lastDroppedFrames_ = dropped;

    const targetSec = this.targetLatency_ / 1000;
    const downThreshold = targetSec * 0.3;
    const upThreshold = targetSec * 1.5;

    // DOWN: buffer critically low or excessive dropped frames
    if ((bufferHealth < downThreshold || droppedDelta > 5) &&
        this.currentIndex_ > 0) {
      const newIndex = this.currentIndex_ - 1;
      shaka.log.info('[ABR] DOWN: buffer=' + bufferHealth.toFixed(2) +
          's drops=' + droppedDelta +
          ' -> ' + this.ladder_[newIndex].height + 'p');
      this.switchTo_(newIndex);
      return;
    }

    // UP: sustained healthy buffer for 5+ seconds
    if (bufferHealth > upThreshold &&
        this.currentIndex_ < this.ladder_.length - 1) {
      if (this.state_ !== 'stable') {
        this.state_ = 'stable';
        this.stableStart_ = Date.now();
      } else if (Date.now() - this.stableStart_ > 5000) {
        const newIndex = this.currentIndex_ + 1;
        shaka.log.info('[ABR] UP: buffer=' + bufferHealth.toFixed(2) +
            's stable=' +
            ((Date.now() - this.stableStart_) / 1000).toFixed(0) +
            's -> ' + this.ladder_[newIndex].height + 'p');
        this.switchTo_(newIndex);
        return;
      }
    } else {
      if (this.state_ === 'stable' && bufferHealth <= upThreshold) {
        this.stableStart_ = Date.now();
      }
    }
  }

  /**
   * Switch to a new ladder index.
   * @param {number} newIndex
   * @private
   */
  switchTo_(newIndex) {
    if (newIndex < 0 || newIndex >= this.ladder_.length) {
      return;
    }
    this.currentIndex_ = newIndex;
    this.switchCount_++;
    this.state_ = 'recovering';
    this.stableStart_ = Date.now();

    const variant = this.ladder_[newIndex].variant;
    if (this.switch_) {
      this.switch_(variant);
      shaka.log.info('[ABR] Switched to ' +
          this.ladder_[newIndex].height + 'p');
    }
  }
};
