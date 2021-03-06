// Copyright 2015 Foursquare Labs, Inc.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
define([
  'angular',
  'lodash',
  'jquery',
  'app/core/utils/datemath',
  'moment',
],
function (angular, _, $, dateMath, moment) {
  'use strict';

  /** @ngInject */
  function ClouderaManagerDatasource(instanceSettings, $q, backendSrv) {
    this.url = instanceSettings.url;
    if (this.url.endsWith('/')) {
      this.url = this.url.substr(0, this.url.length - 1);
    }
    this.basicAuth = instanceSettings.basicAuth;
    this.withCredentials = instanceSettings.withCredentials;
    this.name = instanceSettings.name;

    this.apiVersion = 4;
    if (instanceSettings.jsonData.cmAPIVersion === 'v6-10') {
      this.apiVersion = 6;
    } else if (instanceSettings.jsonData.cmAPIVersion === 'v11+') {
      this.apiVersion = 11;
    }

    // Helper to make API requests to Cloudera Manager. To avoid CORS issues, the requests may be proxied
    // through Grafana's backend via `backendSrv.datasourceRequest`.
    this._request = function(options) {
      options.url = this.url + options.url;
      options.method = options.method || 'GET';
      options.inspect = { 'type': 'cloudera_manager' };

      if (this.basicAuth) {
        options.withCredentials = true;
        options.headers = {
          "Authorization": this.basicAuth
        };
      }

      return backendSrv.datasourceRequest(options);
    };

    // Test the connection to Cloudera Manager by querying for the supported API version.
    this.testDatasource = function() {
      var options = {
        url: '/api/version',
        transformResponse: function(data) {
          return data;
        }
      };

      return this._request(options).then(function(response) {
        return {
          status: "success",
          message: "Data source is working. API version is '" + response.data + "'.",
          title: "Success"
        };
      });
    };

    // Query for metric targets within the specified time range.
    // Returns the promise of a result dictionary. See the convertResponse comment
    // for specifics of the result dictionary.
    this.query = function(queryOptions) {
      var self = this;

      var targetPromises = _(queryOptions.targets)
        .filter(function(target) { return target.target && !target.hide; })
        .map(function(target) {
          var requestOptions = {
            url: '/api/v' + self.apiVersion + '/timeseries',
            params: {
              query: target.target,
              from: queryOptions.range.from.toJSON(),
              to: queryOptions.range.to.toJSON(),
            }
          };

          if (self.apiVersion >= 6) {
            requestOptions.params.contentType = 'application/json';
          }

          return self._request(requestOptions).then(_.bind(self.convertResponse, self));
        })
        .value();

      return $q.all(targetPromises).then(function(convertedResponses) {
        var result = {
          data: _.map(convertedResponses, function(convertedResponse) {
            return convertedResponse.data;
          })
        };
        result.data = _.flatten(result.data);
        return result;
      });
    };

    // Convert the metadata returned from Cloudera Manager into the timeseries name for Grafana.
    this._makeTimeseriesName = function(metadata) {
      if (metadata.metricName && metadata.entityName) {
        return metadata.metricName + ' (' + metadata.entityName  + ')';
      } else if (metadata.metricName) {
        return metadata.metricName;
      } else if (metadata.entityName) {
        return metadata.entityName;
      } else {
        return 'UNKNOWN NAME';
      }
    };

    // Convert the Cloudera Manager response to the format expected by Grafana.
    //
    // Grafana generally expects:
    // { data: [
    //   { target: 'metricName1',
    //     datapoints: [ [a1, ts-a1], [a2, ts-a2], [a3, ts-a3] ]
    //   },
    //   { target: 'metricName2',
    //     datapoints: [ [b1, ts-b1], [b2, ts-b2], [c3, ts-b3] ]
    //   },
    // ]}
    //
    // The CM API response has the general form:
    // items: {
    //   timeSeries: [
    //     {
    //       metadata: {
    //         metricName: "metricName1",
    //         entityName: "entityName1",
    //         ...
    //       },
    //       data: [
    //         {
    //           value: 45.1234,
    //           timestamp: "2015-10-02T12:58:24.009Z",
    //           ...
    //         }, {
    //           value: 98.7654,
    //           timestamp: "2015-10-02T12:59:24.009Z",
    //           ...
    //         }
    //         ... (more datapoints)
    //       ]
    //     }
    //     ... (more timeseries)
    //   ]
    // }
    this.convertResponse = function(response) {
      var self = this;

      if (!response || !response.data || !response.data.items) { return []; }

      var seriesList = [];
      _(response.data.items).forEach(function(item) {
        _.forEach(item.timeSeries, function(timeSeries) {
          seriesList.push({
            target: self._makeTimeseriesName(timeSeries.metadata),
            datapoints: _.map(timeSeries.data, function(point) {
              var ts = moment.utc(dateMath.parse(point.timestamp)).unix() * 1000;
              return [point.value, ts];
            })
          });
        });
      });

      return {data: seriesList};
    };
  }
  
  return ClouderaManagerDatasource;
});
