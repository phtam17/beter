// All fixtures and prices are fixed examples, independent of real schedules.
const fixture = (id, sport, league, time, away, home, markets) => ({ id, sport, league, time, away, home, markets });
const team = (name, short, record) => ({ name, short, record });
export const events = [
  fixture('bos-ny', 'Basketball', 'NBA', '7:30 PM', team('Boston Celtics','BOS','Away'), team('New York Knicks','NYK','Home'), [[[-4.5,-110],[4.5,-110]],[[-175],[150]],[['O 224.5',-110],['U 224.5',-110]]]),
  fixture('kc-buf', 'Football', 'NFL', '8:20 PM', team('Kansas City Chiefs','KC','Away'), team('Buffalo Bills','BUF','Home'), [[[-2.5,-115],[2.5,-105]],[[-145],[125]],[['O 47.5',-110],['U 47.5',-110]]]),
  fixture('gs-lal', 'Basketball', 'NBA', '10:00 PM', team('Golden State Warriors','GSW','Away'), team('Los Angeles Lakers','LAL','Home'), [[[3.5,-110],[-3.5,-110]],[[140],[-165]],[['O 231.5',-110],['U 231.5',-110]]]),
  fixture('nyr-bos', 'Hockey', 'NHL', '7:00 PM', team('New York Rangers','NYR','Away'), team('Boston Bruins','BOS','Home'), [[[1.5,-190],[-1.5,160]],[[115],[-135]],[['O 5.5',105],['U 5.5',-125]]]),
  fixture('phi-dal', 'Football', 'NFL', '4:25 PM', team('Philadelphia Eagles','PHI','Away'), team('Dallas Cowboys','DAL','Home'), [[[-3.5,-105],[3.5,-115]],[[-180],[155]],[['O 48.5',-110],['U 48.5',-110]]]),
  fixture('col-edm', 'Hockey', 'NHL', '9:00 PM', team('Colorado Avalanche','COL','Away'), team('Edmonton Oilers','EDM','Home'), [[[1.5,-210],[-1.5,175]],[[110],[-130]],[['O 6.5',-105],['U 6.5',-115]]])
];
export const sports = ['All sports','Basketball','Football','Hockey'];
export const marketNames = ['Spread','Moneyline','Total'];
export function getSelection(eventId, marketIndex, teamIndex) {
  const event = events.find(e=>e.id===eventId);
  if (!event) throw new Error('This practice market is unavailable.');
  const market = event.markets[marketIndex]?.[teamIndex];
  if (!market) throw new Error('This selection is unavailable.');
  const currentTeam = teamIndex === 0 ? event.away : event.home;
  const odds = marketIndex===1 ? market[0] : market[1];
  const line = marketIndex===1 ? 'To win' : marketIndex===0 ? (market[0]>0?'+':'')+market[0] : market[0];
  return { id:`${eventId}-${marketIndex}-${teamIndex}`,eventId,eventName:`${event.away.short} at ${event.home.short}`,team:marketIndex===2?`Total ${line}`:currentTeam.name,market:marketNames[marketIndex],line,odds,sport:event.sport,startsAt:`Sample fixture, ${event.time}` };
}
