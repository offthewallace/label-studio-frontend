import "moment-duration-format";
import React from "react";
import { TimeSeries } from "pondjs";
import { observer, inject } from "mobx-react";
import { types } from "mobx-state-tree";

import * as d3 from "d3";
import ObjectBase from "../Base";
import Registry from "../../../core/Registry";
import Types from "../../../core/Types";
import { guidGenerator } from "../../../core/Helpers";
import { runTemplate } from "../../../core/Template";
import {
  idFromValue,
  line,
  getRegionColor,
  fixMobxObserve,
  formatTrackerTime,
  sparseValues,
  getOptimalWidth,
} from "./helpers";
import { format as formatFNS } from "date-fns";

/**
 * TimeSeriesChannel tag can be used to label time series data
 * @example
 * <View>
 *   <TimeSeries name="video" value="$timestamp">
 *      <TimeSeriesChannel value="$sensor1" />
 *      <TimeSeriesChannel value="$sensor2" />
 *   </TimeSeries>
 * </View>
 * @param {string} displayName name of the channel
 * @param {string} units units name
 * @param {string} unitsFormat format string for the units
 * @param {string} caption show channel caption view, like channel name, etc
 * @param {string} interpolation line interpolation mode
 * @param {string} showGrid show grid on the plot
 * @param {string} showTracker show tracker line on the plot
 * @param {string} height height of the plot
 * @param {string} opacity opacity of the line
 * @param {string=} [strokeColor=#f48a42] stroke color
 * @param {number=} [strokeWidth=1] width of the stroke
 * @param {string} value value
 */

const csMap = {
  curvestep: "curveStep",
  curvebasis: "curvebasis",
  curvebasisopen: "curveBasisOpen",
  curvebundle: "curveBundle",
  curvecardinal: "curveCardinal",
  curvecardinalopen: "curveCardinalOpen",
  curvecatmullrom: "curveCatmullRom",
  curvecatmullromopen: "curveCatmullRomOpen",
  curvelinear: "curveLinear",
  curvemonotonex: "curveMonotoneX",
  curvemonotoney: "curveMonotoneY",
  curvenatural: "curveNatural",
  curveradial: "curveRadial",
  curvestep: "curveStep",
  curvestepafter: "curveStepAfter",
  curvestepbefore: "curveStepBefore",
};

const TagAttrs = types.model({
  displayname: types.maybeNull(types.string),

  units: types.maybeNull(types.string),
  unitsformat: types.optional(types.string, ".1f"),
  caption: types.optional(types.boolean, true), // show channel caption view, like channel name, etc

  interpolation: types.optional(types.enumeration(Object.values(csMap)), "curveStep"),

  showgrid: types.optional(types.boolean, false),
  showtracker: types.optional(types.boolean, true),

  height: types.optional(types.string, "200"),

  opacity: types.optional(types.string, "0.8"),
  strokewidth: types.optional(types.string, "1"),
  strokecolor: types.optional(types.string, "#000000"),

  value: types.maybeNull(types.string),
});

const Model = types
  .model("TimeSeriesChannelModel", {
    id: types.optional(types.identifier, guidGenerator),
    type: "timeserieschannel",
    children: Types.unionArray(["channel", "view"]),
    // _value: types.optional(types.string, ""),
  })
  .views(self => ({
    get parent() {
      return Types.getParentOfTypeString(self, "TimeSeriesModel");
    },
  }))
  .preProcessSnapshot(snapshot => {
    snapshot.interpolation = csMap[snapshot.interpolation];
    return snapshot;
  });

const TimeSeriesChannelModel = types.compose("TimeSeriesChannelModel", Model, TagAttrs, ObjectBase);

// clear d3 sourceEvent via async call to prevent infinite loops
const clearD3Event = f => setTimeout(f, 0);

class ChannelD3 extends React.Component {
  state = {
    width: 840,
  };

  ref = React.createRef();
  gBrushes;
  id = String(Math.round(Math.random() * 100000));

  // @todo describe
  optimizedSeries = null;
  needZoomOptimization = false;
  zoomStep = 10;

  line;
  lineSlice;

  changeWidth = () => {
    const offsetWidth = this.ref.current.offsetWidth;
    console.log("WIDTH", offsetWidth);
    const { margin } = this.props.item.parent;
    if (offsetWidth) {
      const width = offsetWidth - margin.left - margin.right;
      this.setState({ width });
    }
  };

  getRegion(selection, isInstant) {
    const [start, end] = selection.map(n => +this.stick(n)[0]);
    return { start, end: isInstant ? start : end };
  }

  renderBrushes(ranges, flush = false) {
    const { width } = this.state;
    const height = +this.props.item.height;
    const extent = [
      [0, 0],
      [width, height],
    ];
    const managerBrush = d3.brushX().extent(extent);
    const x = this.x;
    const handleSize = 3;

    if (flush) {
      this.gBrushes.selectAll(".brush").remove();
    }

    const brushSelection = this.gBrushes.selectAll(".brush").data(ranges, r => r.id);

    const brushend = id => () => {
      if (!d3.event.sourceEvent || !d3.event.selection) return;
      const i = ranges.findIndex(range => range.id === id);
      if (i < 0) console.error(`REGION ${id} was not found`);
      const r = ranges[i];
      const moved = this.getRegion(d3.event.selection, r.instant);
      // click simulation - if selection didn't move
      if (moved.start === r.start && moved.end === r.end) {
        clearD3Event(() => {
          this.props.item.parent.completion.regionStore.unselectAll();
          r.selectRegion();
          this.props.item.parent.updateView();
        });
      } else {
        // clear d3 sourceEvent via async call
        clearD3Event(() => this.props.item.parent.regionChanged(moved, i));
      }
    };

    // Set up new brushes
    brushSelection
      .enter()
      .append("g")
      .attr("class", "brush")
      .attr("id", r => `brush_${this.id}_${r.id}`)
      .each(function(r, i) {
        const brush = d3.brushX().extent(extent);

        brush.on("end", brushend(r.id));

        const group = d3.select(this);

        brush(group);

        if (r.instant) {
          // no resizing, only moving
          group.selectAll(".handle").style("pointer-events", "none");
        } else {
          group.selectAll(".selection").style("pointer-events", "none");

          group
            .append("rect")
            .attr("class", "clicker")
            .attr("y", 0)
            .attr("height", height)
            .attr("x", x(r.start) + handleSize)
            .attr("width", x(r.end) - x(r.start) - handleSize * 2);
        }
        group.selectAll(".overlay").style("pointer-events", "none");
      })
      .merge(brushSelection)
      .each(function(r, i) {
        const group = d3.select(this);
        const selection = group.selectAll(".selection");
        const color = getRegionColor(r);
        if (r.instant) {
          selection
            .attr("stroke-opacity", r.selected || r.highlighted ? 0.6 : 0.2)
            .attr("fill-opacity", r.selected || r.highlighted ? 1 : 0.6)
            .attr("stroke-width", 3)
            .attr("stroke", color)
            .attr("fill", color);
          const at = x(r.start);
          managerBrush.move(d3.select(this), [at, at + 1]);
        } else {
          selection
            .attr("stroke-opacity", r.selected || r.highlighted ? 0.8 : 0.5)
            .attr("fill-opacity", r.selected || r.highlighted ? 0.6 : 0.3)
            .attr("stroke", color)
            .attr("fill", color);
          group
            .selectAll(".clicker")
            .attr("x", x(r.start) + handleSize)
            .attr("width", x(r.end) - x(r.start) - handleSize * 2);
          managerBrush.move(d3.select(this), [r.start, r.end].map(x));
        }
      });
    brushSelection.exit().remove();
  }

  brushCreator() {
    if (this.gCreator) {
      this.gCreator.selectAll("*").remove();
    } else {
      this.gCreator = this.main.append("g").attr("class", "new_brush");
    }

    const { width } = this.state;
    const height = +this.props.item.height;
    const brush = d3
      .brushX()
      .extent([
        [0, 0],
        [width, height],
      ])
      .on("end", () => {
        const parent = this.props.item.parent;
        const activeStates = parent.activeStates();
        const statesSelected = activeStates && activeStates.length;
        if (!d3.event.sourceEvent) return;
        if (!d3.event.selection) {
          if (statesSelected) {
            const x = d3.mouse(d3.event.sourceEvent.target)[0];
            const region = this.getRegion([x, x]);
            clearD3Event(() => {
              parent.regionChanged(region, this.props.ranges.length);
            });
          }
          return;
        }
        const region = this.getRegion(d3.event.selection);
        clearD3Event(() => brush.move(this.gCreator, null));
        if (!statesSelected) return;
        clearD3Event(() => {
          parent.regionChanged(region, this.props.ranges.length);
        });
      });
    this.gCreator.call(brush);
  }

  renderAxis = () => {
    const { item } = this.props;
    const { width } = this.state;
    const { margin } = item.parent;
    const height = +item.height;
    const tickSize = height + margin.top;
    const shift = -margin.top;
    this.gx
      .attr("transform", `translate(0,${shift})`)
      .call(
        d3
          .axisBottom(this.x)
          .ticks(width / 80)
          .tickSize(tickSize + 4),
      )
      .call(g => g.selectAll(".domain").remove())
      // @todo `clone is not a function` wtf?
      // .call(g => g.selectAll(".tick line").clone().attr("y1", 18).attr("y2", 22));
      .call(g =>
        g
          .selectAll(".tick")
          .attr("stroke-opacity", 0.2)
          .selectAll(".bottom")
          .data([0])
          .enter()
          .append("line")
          .attr("class", "bottom")
          .attr("stroke", "currentColor")
          .attr("y1", tickSize + 16)
          .attr("y2", tickSize + margin.bottom),
      );
  };

  componentDidMount() {
    const { data, item, range, time, value } = this.props;
    const { isDate, format, margin } = item.parent;
    const height = +item.height;
    const times = data[time];
    const values = data[value];
    const { series } = this.props;
    this.needZoomOptimization = series.length > getOptimalWidth() * this.zoomStep;
    if (this.needZoomOptimization) {
      this.optimizedSeries = sparseValues(series, getOptimalWidth() * this.zoomStep);
    }
    this.slices = item.parent.dataSlices;

    const formatValue = d3.format(item.unitsformat);
    let formatTime = String;
    if (format === "date")
      formatTime = v =>
        new Date(v)
          .toISOString()
          .substr(0, 19)
          .replace("T", " ");
    else if (format) formatTime = isDate ? v => formatFNS(v, format) : d3.format(format);
    this.formatValue = formatValue;
    this.formatTime = formatTime;

    if (!this.ref.current) return;

    const offsetWidth = this.ref.current.offsetWidth;
    const width = offsetWidth ? offsetWidth - margin.left - margin.right : this.state.width;
    // intention direct assignment to avoid rerender and correct initialization
    // eslint-disable-next-line react/no-direct-mutation-state
    this.state.width = width;

    const scale = isDate ? d3.scaleTime() : d3.scaleLinear();
    const x = scale
      // .clamp(true)
      .domain(d3.extent(times))
      .range([0, width]);

    const y = d3
      .scaleLinear()
      .domain([d3.min(values), d3.max(values)])
      .range([height - margin.max, margin.min]);

    const stick = screenX => {
      const dataX = x.invert(screenX);
      let i = d3.bisectLeft(times, dataX);
      if (dataX - times[i] > times[i + 1] - dataX) i++;
      return [times[i], values[i]];
    };

    this.x = x;
    this.y = y;
    this.plotX = x.copy();
    this.stick = stick;

    this.line = d3
      .line()
      .y(d => this.y(d[value]))
      .x(d => this.plotX(d[time]));

    this.lineSlice = d3
      .line()
      .defined(d => d[time] >= range[0] && d[time] <= range[1])
      .y(d => this.y(d[value]))
      .x(d => this.x(d[time]));

    //////////////////////////////////
    const main = d3
      .select(this.ref.current)
      .append("svg")
      .attr("viewBox", [0, 0, width + margin.left + margin.right, height + margin.top + margin.bottom])
      .style("display", "block")
      .append("g")
      .on("mousemove", onHover)
      .attr("transform", "translate(" + margin.left + "," + margin.top + ")");

    main
      .append("clipPath")
      .attr("id", `clip_${this.id}`)
      .append("rect")
      .attr("x", 0)
      .attr("y", 0)
      .attr("height", height)
      .attr("width", width);

    main
      .append("text")
      .text(item.displayname)
      .attr("dx", "1em")
      .attr("dy", "1em")
      .attr("font-weight", "bold")
      .attr("font-size", "1.4em")
      .attr("dy", "1em")
      .attr("opacity", 0.1);

    this.main = main;

    const pathContainer = main.append("g").attr("clip-path", `url("#clip_${this.id}")`);
    this.path = pathContainer
      .append("path")
      .datum(this.needZoomOptimization ? this.optimizedSeries : series)
      .attr("d", this.line);
    this.path2 = pathContainer.append("path");

    pathContainer
      .selectAll("path")
      .attr("vector-effect", "non-scaling-stroke")
      .attr("fill", "none")
      .attr("stroke", item.strokecolor || "steelblue");

    // this.drawPath();

    const tracker = main.append("g");
    const trackerValue = tracker
      .append("text")
      .attr("font-size", 10)
      .attr("fill", "#666");
    const trackerTime = tracker
      .append("text")
      .attr("y", height - 1)
      .attr("font-size", 10)
      .attr("fill", "#666");
    const trackerPoint = tracker
      .append("circle")
      .attr("cx", 0)
      .attr("r", 3)
      .attr("stroke", "red")
      .attr("fill", "none");
    tracker
      .append("line")
      .attr("y1", height)
      .attr("y2", 0)
      .attr("stroke", "#666");

    const updateTracker = screenX => {
      const { width } = this.state;
      if (screenX < 0 || screenX > width) return;
      const [dataX, dataY] = stick(screenX);
      tracker.attr("transform", `translate(${x(dataX) + 0.5},0)`);
      trackerTime.text(formatTime(dataX));
      trackerValue.text(formatValue(dataY) + " " + item.units);
      trackerPoint.attr("cy", y(dataY));
      tracker.attr("text-anchor", screenX > width - 100 ? "end" : "start");

      d3.event.preventDefault();
    };

    function onHover() {
      updateTracker(d3.mouse(this)[0]);
    }

    this.gx = main.append("g");
    main
      .append("g")
      .call(
        d3
          .axisLeft(y)
          .tickFormat(formatValue)
          .tickSize(3),
      )
      .call(g => g.select(".domain").remove())
      .call(g =>
        g
          .append("text")
          .attr("class", "title")
          .attr("font-size", 8)
          .attr("x", -6)
          .attr("y", 0)
          .attr("fill", "currentColor")
          .attr("text-anchor", "end")
          .text(item.units),
      );

    this.setRangeWithScaling(range);

    this.brushCreator();

    // We initially generate a SVG group to keep our brushes' DOM elements in:
    this.gBrushes = main
      .append("g")
      .attr("class", "brushes")
      .attr("clip-path", `url("#clip_${this.id}")`);

    this.renderBrushes(this.props.ranges);

    window.addEventListener("resize", this.changeWidth);
  }

  componentWillUnmount() {
    window.removeEventListener("resize", this.changeWidth);
  }

  setRangeWithScaling(range) {
    this.x.domain(range);
    const current = this.x.range();
    const all = this.plotX.domain().map(this.x);
    const scale = (all[1] - all[0]) / (current[1] - current[0]);
    const left = Math.max(0, Math.floor((this.zoomStep * (current[0] - all[0])) / (all[1] - all[0])));
    const right = Math.max(0, Math.floor((this.zoomStep * (current[1] - all[0])) / (all[1] - all[0])));
    const translate = all[0] - current[0];
    console.log(
      "SOME MATH",
      left,
      right,
      [...range],
      this.plotX.domain(),
      current,
      all,
      scale,
      translate,
      this.needZoomOptimization,
    );

    if (this.optimizedSeries && scale > this.zoomStep === this.needZoomOptimization) {
      this.needZoomOptimization = !this.needZoomOptimization;
      if (this.needZoomOptimization) {
        this.path.datum(this.optimizedSeries);
        this.path.attr("d", this.line);
      } else {
        this.path.attr("transform", ``);
      }
    }

    if (this.needZoomOptimization) {
      this.path.attr("transform", `translate(${translate} 0) scale(${scale} 1)`);
      this.path2.attr("d", "");
    } else {
      if (this.optimizedSeries) {
        this.path.datum(this.slices[left]);
        this.path.attr("d", this.lineSlice);
        if (left !== right) {
          this.path2.datum(this.slices[right]);
          this.path2.attr("d", this.lineSlice);
        } else {
          this.path2.attr("d", "");
        }
      } else {
        this.path.attr("d", this.lineSlice);
        this.path2.attr("d", "");
      }
    }

    this.renderAxis();
  }

  componentDidUpdate(prevProps, prevState) {
    const { range } = this.props;
    const { width } = this.state;
    let flushBrushes = false;

    if (width !== prevState.width) {
      console.log("STATE CHANGED", this.state.width);
      const { item, range } = this.props;
      const { margin } = item.parent;
      const height = +item.height;
      const svg = d3.select(this.ref.current).selectAll("svg");

      svg.attr("viewBox", [0, 0, width + margin.left + margin.right, height + margin.top + margin.bottom]);
      this.x.range([0, width]);
      this.gCreator.each(function() {
        this.innerHTML = "";
      });
      this.brushCreator();
      svg.selectAll("clipPath rect").attr("width", width);

      this.setRangeWithScaling(range);
      this.brushCreator();
      flushBrushes = true;
    } else {
      const domain = this.x.domain();
      if (+domain[0] !== +range[0] || +domain[1] !== +range[1]) {
        this.setRangeWithScaling(range);
      }
    }

    this.renderBrushes(this.props.ranges, flushBrushes);
  }

  render() {
    this.props.ranges.map(r => fixMobxObserve(r.start, r.end, r.selected, r.highlighted));
    fixMobxObserve(this.props.range.map(Number));

    return <div ref={this.ref} length={this.props.ranges} />;
  }
}

const ChannelD3Observed = observer(ChannelD3);

// const HtxTimeSeriesChannelView = observer(({ store, item }) => <TS series={item._simple} />);
const HtxTimeSeriesChannelViewD3 = ({ item }) => {
  // @todo maybe later for some other option
  // let channels = item.parent.overviewchannels;
  // if (channels) channels = channels.split(",");
  // if (channels && !channels.includes(item.value.substr(1))) return null;

  return (
    <ChannelD3Observed
      time={idFromValue(item.parent.value)}
      value={idFromValue(item.value)}
      item={item}
      data={item.parent.dataObj}
      series={item.parent.dataHash}
      // @todo initialBrush is out of store, but it triggers; change to brushRange
      range={item.parent.brushRange}
      ranges={item.parent.regions}
      forceUpdate={item.parent._needsUpdate}
    />
  );
};

const HtxTimeSeriesChannel = observer(HtxTimeSeriesChannelViewD3);

Registry.addTag("timeserieschannel", TimeSeriesChannelModel, HtxTimeSeriesChannel);

export { TimeSeriesChannelModel, HtxTimeSeriesChannel };
