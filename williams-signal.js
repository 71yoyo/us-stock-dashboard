// Pages의 목록·상세 화면과 Worker의 일봉 동기화가 같은 신호 규칙을 사용한다.
(function attachWilliamsSignalEngine() {
  const PERIOD = 14;

  function calculate(candles) {
    if (!Array.isArray(candles)) return [];
    const values = [];
    for (let index = PERIOD - 1; index < candles.length; index += 1) {
      const window = candles.slice(index - PERIOD + 1, index + 1);
      const highest = Math.max(...window.map(candle => Number(candle.high)));
      const lowest = Math.min(...window.map(candle => Number(candle.low)));
      const close = Number(candles[index].close);
      const previousClose = Number(candles[index - 1].close);
      if (![highest, lowest, close, previousClose].every(Number.isFinite) || highest < lowest) continue;
      const value = highest === lowest ? -50 : ((highest - close) / (highest - lowest)) * -100;
      values.push({ time: candles[index].time, value, close });
    }
    return values;
  }

  function summarize(candles) {
    const values = calculate(candles);
    const latest = values.at(-1);
    if (!latest) return null;
    const previous = values.at(-2);
    const beforePrevious = values.at(-3);
    const rising = previous && latest.value > previous.value;
    const falling = previous && latest.value < previous.value;
    const zoneClass = latest.value <= -80 ? 'buy' : latest.value >= -20 ? 'sell' : 'hold';
    const status = zoneClass === 'buy' ? '과매도 구간' : zoneClass === 'sell' ? '과매수 구간' : '중립 구간';
    // 기준선에 닿은 날 한 번만 표시한다. -20에서 다음 날 -30으로 내려가도 재발행하지 않는다.
    const buyCross = rising && previous.value < -80 && latest.value >= -80;
    const sellCross = falling && previous.value > -20 && latest.value <= -20;
    // 지표만 기준선을 벗어난 경우에는 종가 방향이 확인될 때까지 신호를 확정하지 않는다.
    const delayedBuy = beforePrevious && previous.value >= -80 && latest.value > -80
      && beforePrevious.value <= -80 && previous.value > beforePrevious.value
      && previous.close <= beforePrevious.close && latest.close > previous.close;
    const delayedSell = beforePrevious && previous.value <= -20 && latest.value < -20
      && beforePrevious.value >= -20 && previous.value < beforePrevious.value
      && previous.close >= beforePrevious.close && latest.close < previous.close;

    let label;
    let className;
    let since = null;
    if ((buyCross && latest.close > previous.close) || delayedBuy) {
      label = '매수 신호';
      className = 'buy';
      since = latest.time;
    } else if ((sellCross && latest.close < previous.close) || delayedSell) {
      label = '매도 신호';
      className = 'sell';
      since = latest.time;
    } else if (buyCross || sellCross) {
      label = `${buyCross ? '매수' : '매도'} 종가 확인 대기`;
      className = buyCross ? 'buy' : 'sell';
    } else if (zoneClass === 'buy') {
      label = rising ? '매수 검토' : '매수 신호 유지';
      className = 'buy';
    } else if (zoneClass === 'sell') {
      label = falling ? '매도 검토' : '매도 신호 유지';
      className = 'sell';
    } else {
      label = rising ? '관찰-상승중' : falling ? '관찰-하락중' : '관찰-보합';
      className = 'hold';
    }

    return { value: latest.value, lastCandleDate: latest.time, status, zoneClass,
      signal: { label, className, since, reviewLabel: null } };
  }

  globalThis.WilliamsSignalEngine = Object.freeze({ calculate, summarize });
})();
