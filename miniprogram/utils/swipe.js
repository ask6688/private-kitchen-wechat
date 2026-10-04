module.exports = {
  swipeStart(e) {
    this.swipeMoved = false
    this.swipeOrigin = { id: e.currentTarget.dataset.id, x: e.touches[0].clientX, y: e.touches[0].clientY }
  },
  swipeEnd(e) {
    const start = this.swipeOrigin
    this.swipeOrigin = null
    if (!start || ['completed', 'cancelled'].includes(this.data.status) || start.id !== e.currentTarget.dataset.id || !e.changedTouches.length) return
    const dx = e.changedTouches[0].clientX - start.x, dy = e.changedTouches[0].clientY - start.y
    if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy)) {
      this.swipeMoved = true
      this.setData({ openId: dx < 0 ? start.id : '' })
    }
  },
}
