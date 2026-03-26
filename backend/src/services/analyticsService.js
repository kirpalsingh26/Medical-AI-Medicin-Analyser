import { Analytics } from '../models/Analytics.js';

export const analyticsService = {
  track: async (event, user, metadata = {}) => {
    return Analytics.create({ event, user, metadata });
  },

  summary: async () => {
    const totalEvents = await Analytics.countDocuments();

    const byEvent = await Analytics.aggregate([
      { $group: { _id: '$event', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]);

    const daysBack = 14;
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - (daysBack - 1));
    startDate.setHours(0, 0, 0, 0);

    const byDayRaw = await Analytics.aggregate([
      { $match: { createdAt: { $gte: startDate } } },
      {
        $group: {
          _id: {
            $dateToString: {
              format: '%Y-%m-%d',
              date: '$createdAt'
            }
          },
          count: { $sum: 1 }
        }
      },
      { $sort: { _id: 1 } }
    ]);

    const byDayMap = new Map(byDayRaw.map((item) => [item._id, item.count]));
    const byDay = [];
    for (let i = 0; i < daysBack; i += 1) {
      const day = new Date(startDate);
      day.setDate(startDate.getDate() + i);
      const key = day.toISOString().slice(0, 10);
      byDay.push({ date: key, count: byDayMap.get(key) || 0 });
    }

    const topUsersRaw = await Analytics.aggregate([
      { $match: { user: { $ne: null } } },
      { $group: { _id: '$user', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 10 }
    ]);

    const topUsers = topUsersRaw.map((item) => ({ userId: String(item._id), count: item.count }));

    const recentEvents = await Analytics.find({})
      .sort({ createdAt: -1 })
      .limit(15)
      .select('event metadata createdAt user')
      .lean();

    const activeDays = byDay.filter((item) => item.count > 0).length;
    const avgEventsPerActiveDay = activeDays ? Number((totalEvents / activeDays).toFixed(2)) : 0;
    const peakEvent = byEvent[0]?._id || null;

    return {
      totalEvents,
      byEvent,
      byDay,
      recentEvents,
      topUsers,
      metrics: {
        uniqueEventTypes: byEvent.length,
        activeDays,
        avgEventsPerActiveDay,
        peakEvent
      }
    };
  }
};