'use strict';

var Promise = require('./promise');
var normalizeObj = require('./normalizeObj');
var makeError = require('./makeError');
var checkTile = require('./checkTile');
var merc = require('./merc');
var mime = require('mime');
var mapnik = require('mapnik');
var Image = mapnik.Image;
var blend = mapnik.blend;
var Color = mapnik.Color;
var defaultCache = require('./memCache');
var EE = require('events').EventEmitter;
var makeUnknownError = require('./makeUnknownError');
var abaculus = Promise.promisify(require('abaculus'));
var getEtag = require('./getEtag');
var find = require('./find');
var requiredParams = [
  'layers',
  'bbox',
  'width',
  'height',
  'format',
  'srs'
];

var fromBytes = Promise.promisify(Image.fromBytes);
function mapnikResize (img, width, height) {
  return new Promise((yes, no) => {
    img.resize(width, height, (err, resp) => {
      if (err) {
        no(err);
      } else {
        yes(resp);
      }
    });
  });
}
function mapnikEncode (img, format) {
  return new Promise((yes, no) => {
    img.encode(format, (err, resp) => {
      if (err) {
        no(err);
      } else {
        yes(resp);
      }
    });
  });
}
function maybePremultiply(img) {
  if (img.premultiplied()) {
    return Promise.resolve(img);
  }
  return new Promise((yes, no) => {
    img.premultiply((err, buf)=>{
      if (err) {
        return no(err);
      }
      yes(buf);
    });
  });
}
const resize = Promise.coroutine(function * resize(image, format, width, height) {
  image = Array.isArray(image) ? image[0] : image;
  let mapnikImage = yield fromBytes(image);
  let maybePremultiplied = yield maybePremultiply(mapnikImage);
  let resized = yield mapnikResize(maybePremultiplied, width, height);
  let output = yield mapnikEncode(resized, format);
  return output;
});

var getMap = Promise.coroutine(function * getMap(layer, rawParams) {
  try {
    layer = yield layer;
  } catch (e) {
    return makeUnknownError(e);
  }
  if (!layer) {
    throw new TypeError('must include layer');
  }
  var params = normalizeObj(rawParams);
  var i = -1;
  var len = requiredParams.length;
  var param;
  if (params.crs && !params.srs) {
    params.srs = params.crs;
  }
  while (++i < len) {
    param = requiredParams[i];
    if(!params[param]) {
      return makeError(`missing required parameter: ${param}`, 'MissingParameterValue', param);
    }
  }
  var srs = params.srs || params.crs;
  srs = srs.toLowerCase();
  if (['epsg:900913', 'epsg:3857', 'epsg:4326'].indexOf(srs) === -1) {
    return makeError(`invalid srs: ${srs}`, 'InvalidSRS');
  }
  var scale;
  if (params.dpi || params.map_resolution) {
    scale = Math.round(72 / parseInt(params.dpi || params.map_resolution, 10)) || 1;
  } else {
    scale = 1;
  }
  if (scale !== scale) {
    scale = 1;
  }
  var format = mime.extension(params.format);
  var bgcolor = params.bgcolor || '0xffffff';
  bgcolor = bgcolor.toLowerCase();
  if (params.transparent && params.transparent.toLowerCase() === 'true' && format === 'png') {
    bgcolor = false;
  }
  var abort = layer.abort || new EE();
  layer = makeLayer(layer, params.layers, bgcolor, format, abort);
  if (!layer) {
    return makeError(`No such layer: ${params.layer}`, 'InvalidParameterValue', 'LAYER');
  }
  if (layer.viewable === false) {
    return {
      headers: {},
      data: new Buffer('not authorized'),
      code: 401
    };
  }
  if (typeof layer.getTile !== 'function') {
    throw new TypeError('must include getTile function');
  }
  var bbox = params.bbox.split(',').map(function (num) {
    return parseFloat(num);
  });
  if (['epsg:900913', 'epsg:3857'].indexOf(srs) > -1) {
    bbox = merc.inverse([bbox[0], bbox[1]]).concat(merc.inverse([bbox[2], bbox[3]]));
  }
  var width = parseInt(params.width, 10);
  var height = parseInt(params.height, 10);
  var zoom = getZoom(bbox, [width, height], layer.range[0], layer.range[1]);

  var opts = {
      scale: scale,
      zoom: zoom,
      bbox: bbox,
      getTile: makeGetTile(layer, bgcolor, format),
      format: format
    };
  try {
    var image = yield abaculus(opts);
    if (abort.aborted) {
      throw new Error('aborted');
    }
    var resizedImage = yield resize(image, format, width, height);
    if (abort.aborted) {
      throw new Error('aborted');
    }
    var headers = {
      'content-type': mime.lookup(format),
      'content-length': resizedImage.length,
      etag: getEtag(resizedImage)
    };
    return {
      data: resizedImage,
      headers: headers,
      code: 200
    };
  } catch (e) {
    return makeUnknownError(e);
  }
});
function getZoom(bounds, dimensions, minzoom, maxzoom) {
  minzoom = (minzoom === undefined) ? 0 : minzoom;
  maxzoom = (maxzoom === undefined) ? 20 : maxzoom;


  var bl = merc.px([bounds[0], bounds[1]], maxzoom);
  var tr = merc.px([bounds[2], bounds[3]], maxzoom);
  var width = tr[0] - bl[0];
  var height = bl[1] - tr[1];
  var ratios = [width / dimensions[0], height / dimensions[1]];
  var adjusted = Math.ceil(Math.min(
          maxzoom - (Math.log(ratios[0]) / Math.log(2)),
          maxzoom - (Math.log(ratios[1]) / Math.log(2))));
  return Math.max(minzoom, Math.min(maxzoom, adjusted));

}
module.exports = function (layer, params, cache, callback) {
  if (typeof cache === 'function') {
    callback = cache;
    cache = undefined;
  }
  if (typeof cache === 'undefined') {
    cache = defaultCache;
  }
  return getMap(layer, params, cache).nodeify(callback);
};
var blankPNG = new Buffer('iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAYAAABccqhmAAAABmJLR0QA/wD/AP+gvaeTAAABFUlEQVR42u3BMQEAAADCoPVP7WsIoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAeAMBPAAB2ClDBAAAAABJRU5ErkJggg==', 'base64');
var blanks = new Map();
function callBlankBack(tile, format, callback){
  var headers = {
     'content-type': mime.lookup(format),
     'content-length': tile.length
  };
  callback(null, tile, headers);
}
function sendBlank(bgcolor, format, callback) {
  if (!format) {
    return callback(new Error('not found'));
  }
  if (bgcolor === false) {
    return callBlankBack(blankPNG, format, callback);
  }
  if (bgcolor.slice(0, 2) === '0x') {
    bgcolor = bgcolor.slice(2);
  }
  if (bgcolor.length === 3) {
    bgcolor = bgcolor[0] + bgcolor[0] + bgcolor[1] + bgcolor[1] + bgcolor[2] + bgcolor[2];
  }
  if (bgcolor.length !== 6) {
    bgcolor = 'ffffff';
  }
  var key = bgcolor + format;
  if (blanks.has(key)) {
    return callBlankBack(blanks.get(key), format, callback);
  }
  makeTile(bgcolor, format, function (err, image) {
    if (err) {
      return callback(err);
    }
    if (!blanks.has(key)) {
      blanks.set(key, image);
    }
    callBlankBack(image, format, callback);
  });
}

function makeTile(bgcolor, format, cb) {
  var image = new Image(256, 256);
  image.fill(new Color('#' + bgcolor + 'ff'), function (err, resp) {
    if (err) {
      return cb(err);
    }
    resp.encode(format, cb);
  });
}
function makeGetTile(layer, bgcolor, format) {
  return getTile;
  function getTile(z, x, y, callback) {
    if (checkTile(layer, x, y, z)) {
      return sendBlank(bgcolor, format, callback);
    }
    var aborted = false;
    var req;
    actualGet(true);
    return {
      abort() {
        aborted = true;
        if (req) {
          req.abort();
        }
      }
    }
    function actualGet(retry) {
      req = layer.getTile(z, x, y, function (err, tile, headers) {
        req = null;
        if (err) {
          if (retry && err.message === 'timeout' && !aborted) {
            return actualGet();
          }
          return sendBlank(bgcolor, format, callback);
        }
        callback(null, tile, headers);
      });
    }
  }
}
function makeLayer(layerArray, layerParam, bgcolor, format, abort) {
  if (layerParam.indexOf(',') === -1) {
    return find(layerArray, layerParam);
  }
  var layers = layerParam.split(',');
  var layerObjects = layers.map(function (item) {
    return find(layerArray, item);
  });
  if (layerObjects.some(function (layer) {
    return !layer || layer.viewable === false;
  })) {
    return false;
  }
  return layerObjects.reduce(function (acc, item) {
    acc.range = [Math.min(acc.range[0], item.range[0]), Math.max(acc.range[1], item.range[1])];
    acc.bbox = [Math.min(acc.bbox[0], item.bbox[0]), Math.min(acc.bbox[1], item.bbox[1]),
    Math.max(acc.bbox[2], item.bbox[2]), Math.max(acc.bbox[3], item.bbox[3])];
    return acc;
  }, {
    range: [Infinity, -Infinity],
    bbox: [Infinity, Infinity, -Infinity, -Infinity],
    getTile: makeGetTiles(layerObjects, bgcolor, format, abort)
  });
}
var getFuncMap = new WeakMap();
function noop() {}
function makeGetTiles(layerObjects, bgcolor, format, abort) {
  var aborts = new Set();
  function cancelAll() {
    aborts.forEach(function (f) {
      f();
    });
  }
  abort.on('abort', cancelAll);
  return getTile;
  function getTile(z, x, y, callback) {
    parallel(layerObjects, 2, function(layer){
      return new Promise(function (resolve) {
        var getTile;
        if (getFuncMap.has(layer)) {
          getTile = getFuncMap.get(layer);
        } else {
          getTile = makeGetTile(layer);
          getFuncMap.set(layer, getTile);
        }
        var cancel;
        var out = getTile(z, x, y, function (err, tile, headers) {
            aborts.delete(cancel);
            if (err) {
              return resolve();
            }
            resolve({
              tile: tile,
              headers: headers
            });
          });
        cancel = out.abort || noop;
        aborts.add(cancel);
      });
    }).then(function (things) {
      abort.removeListener('abort', cancelAll);
      var filtered = things.filter(function (item) {
        return item;
      });
      if (!filtered.length) {
        return sendBlank(bgcolor, format, callback);
      }
      blend(filtered.map(function (item) {
                return item.tile;
              }), {
                format: 'png',
                width: 256,
                height: 256}, function (err, resp) {
                  if (err || abort.aborted) {
                    return sendBlank(bgcolor, format, callback);
                  }

                  var headers = {
                    etag: getEtag(resp),
                    'Content-Type': 'image/png'
                  };
                  callback(null, resp, headers);
                });
    });
  }
}
function parallel(list, num, func){
  if(typeof num === 'function'){
    func = num;
    num = 0;
  }
  func = func || function(a){return a};
  return Promise.resolve(list).then(function(list){
    var n = Math.min((num||list.length),list.length);
    return new Promise(function(yes,no){
      var len = list.length;
      var results = [];
      var started = 0;
      var done = 0;
      function callback(i,result){
        results[i] = result;
        if(++done>=len){
          yes(results);
        }else{
          next();
        }
      }
      function next(){
        var i = started++;
        if(started>len){
          return;
        }
        Promise.resolve(list[i]).then(function(value){
          return Promise.resolve(func(value,i)).then(callback.bind(null,i),no);
        }).then(null, no);
      }
      for(var i = 0;i<n;i++){
        next();
      }
    });
  });
}
