import { Plugin } from '@posthog/plugin-scaffold'

declare var posthog: {
    capture: (eventName: string, properties: Record<string, any>) => void
}

type SessionTrackerPlugin = Plugin<{
    config: {
        sessionLength: string
        sessionStartEvent: string
        sessionEndEvent: string
    }
    global: {
        sessionLength: number
        sessionStartEvent: string
        sessionEndEvent: string
    }
    jobs: {
        checkIfSessionIsOver: { distinct_id: string, session_start: string }
    }
}>

export const setupPlugin: SessionTrackerPlugin['setupPlugin'] = ({ global, config }) => {
    global.sessionLength = parseInt(config.sessionLength) || 30
    global.sessionStartEvent = config.sessionStartEvent || 'Session start'
    global.sessionEndEvent = config.sessionEndEvent || 'Session end'
}

export const onEvent: SessionTrackerPlugin['onEvent'] = async (event, { cache, global, jobs }) => {
    // skip this for the session start/end events
    if (event.event === global.sessionStartEvent || event.event === global.sessionEndEvent) {
        return
    }
    const timestamp = event.timestamp || event.properties?.timestamp || event.now || event.sent_at || new Date().toISOString()
    // check if we're the first one to increment this key in the last ${global.sessionLength} minutes
    if ((await cache.incr(`session_${event.distinct_id}`)) === 1) {
        // if so, dispatch a session start event
        posthog.capture(global.sessionStartEvent, { distinct_id: event.distinct_id, timestamp })
        // and launch a job to check in 30min if the session is still alive
        await jobs.checkIfSessionIsOver({ distinct_id: event.distinct_id, session_start: timestamp }).runIn(global.sessionLength, 'minutes')
    }
    // make the key expire in ${global.sessionLength} min
    await cache.expire(`session_${event.distinct_id}`, global.sessionLength * 60)
    await cache.set(
        `last_seen_${event.distinct_id}`,
        timestamp
    )
}

export const jobs: SessionTrackerPlugin['jobs'] = {
    // a background job to check if a session is still in progress
    checkIfSessionIsOver: async ({ distinct_id, session_start }, { jobs, cache, global }) => {
        // check if there's a key that has not expired
        const ping = await cache.get(`session_${distinct_id}`, undefined)
        if (!ping) {
            // if it expired, dispatch the session end event
            const last_seen =
                (await cache.get(`last_seen_${distinct_id}`, undefined)) ||
                new Date(new Date().valueOf() - global.sessionLength * 60000).toISOString()

            await cache.set(`last_seen_${distinct_id}`, undefined)
            const duration_seconds = (new Date(last_seen as string).valueOf() - new Date(session_start).valueOf()) * 1000
            posthog.capture(global.sessionEndEvent, { distinct_id, timestamp: last_seen, "duration.seconds": duration_seconds})
        } else {
            // if the key is still there, check again in a minute
            await jobs.checkIfSessionIsOver({ distinct_id, session_start }).runIn(1, 'minute')
        }
    },
}
