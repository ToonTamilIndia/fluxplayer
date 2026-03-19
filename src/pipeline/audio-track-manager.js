export class AudioTrackManager {
  constructor(streamController) {
    this.streamController = streamController;
    this.tracks = [];
    this.activeIndex = 0;
    this._switchInFlight = null;
  }

  setTracks(tracks, activeIndex = 0) {
    this.tracks = tracks.slice();
    this.activeIndex = Math.max(0, Math.min(activeIndex, this.tracks.length - 1));
  }

  getActiveTrack() {
    return this.tracks[this.activeIndex] || null;
  }

  async switchTo(index) {
    if (index === this.activeIndex) return this.getActiveTrack();
    if (index < 0 || index >= this.tracks.length) {
      throw new Error('Audio track index out of range');
    }

    if (this._switchInFlight) {
      await this._switchInFlight;
    }

    const nextTrack = this.tracks[index];

    this._switchInFlight = this.streamController
      .switchAudioTrack(nextTrack.number)
      .finally(() => {
        this._switchInFlight = null;
      });

    await this._switchInFlight;

    this.activeIndex = index;
    this.tracks = this.tracks.map((track, trackIndex) => ({
      ...track,
      enabled: trackIndex === index,
    }));

    return this.getActiveTrack();
  }
}
