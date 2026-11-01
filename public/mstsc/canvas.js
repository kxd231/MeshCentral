/*
 * Copyright (c) 2015 Sylvain Peyrefitte
 *
 * This file is part of mstsc.js.
 *
 * mstsc.js is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <http://www.gnu.org/licenses/>.
 */

(function() {
	
	/**
	 * Un compress bitmap are reverse in y axis
	 */
	function reverse (bitmap) {
		return { width : bitmap.width, height : bitmap.height, data : new Uint8ClampedArray(bitmap.data) };
	}

	/**
	 * Canvas renderer
	 * @param canvas {canvas} use for rendering
	 */
	function Canvas(canvas) {
		this.canvas = canvas;
		this.ctx = canvas.getContext("2d");
		// All updates (raw and JPEG) are chained here so they are drawn in arrival order
		this.queue = Promise.resolve();
	}
	
	Canvas.prototype = {
		/**
		 * update canvas with new bitmap
		 * @param bitmap {object} bitmap.fmt: 0 or undefined = raw RGBA, 1 = JPEG
		 */
		update : function (bitmap) {
			var self = this;
			this.queue = this.queue.then(function () {
				if (bitmap.fmt == 1) {
					// JPEG tile, decode asynchronously
					return createImageBitmap(new Blob([bitmap.data], { type: 'image/jpeg' })).then(function (img) {
						var ctx = self.ctx;
						ctx.save();
						ctx.setTransform(1, 0, 0, 1, 0, 0); // Same behavior as putImageData, ignore canvas transform
						try { ctx.drawImage(img, bitmap.destLeft, bitmap.destTop); } finally { ctx.restore(); img.close(); }
					});
				}
				var output = reverse(bitmap);
				var imageData = self.ctx.createImageData(output.width, output.height);
				imageData.data.set(output.data);
				self.ctx.putImageData(imageData, bitmap.destLeft, bitmap.destTop);
			}).catch(function (e) {
				console.log('[mstsc.js] bitmap update failed', e);
			});
		}
	}
	
	/**
	 * Module export
	 */
	Mstsc.Canvas = {
		create : function (canvas) {
			return new Canvas(canvas);
		}
	}
})();
