const SESSION_COOKIE =
    'apxn_dashboard_session';


function noStore(res) {
    res.setHeader(
        'Cache-Control',
        'no-store, max-age=0'
    );

    res.setHeader(
        'Pragma',
        'no-cache'
    );

    res.setHeader(
        'X-Content-Type-Options',
        'nosniff'
    );

    res.setHeader(
        'Referrer-Policy',
        'no-referrer'
    );
}


function expiredCookie(
    name,
    path = '/'
) {
    return [
        `${name}=`,
        `Path=${path}`,
        'HttpOnly',
        'Secure',
        'SameSite=Lax',
        'Max-Age=0',
        'Expires=Thu, 01 Jan 1970 00:00:00 GMT'
    ].join('; ');
}


function clearDashboardCookies(
    res
) {
    res.setHeader(
        'Set-Cookie',
        [
            expiredCookie(
                SESSION_COOKIE,
                '/'
            ),

            // Cleanup of the previous
            // experimental Telegram session.
            expiredCookie(
                'apxn_tg_session',
                '/'
            ),

            expiredCookie(
                'apxn_tg_state',
                '/api/telegram-callback'
            ),

            expiredCookie(
                'apxn_tg_verifier',
                '/api/telegram-callback'
            ),

            expiredCookie(
                'apxn_tg_nonce',
                '/api/telegram-callback'
            )
        ]
    );
}


export default async function handler(
    req,
    res
) {
    noStore(res);


    if (
        req.method !== 'POST'
    ) {
        res.setHeader(
            'Allow',
            'POST'
        );

        return res
            .status(405)
            .json({
                error:
                    'METHOD_NOT_ALLOWED'
            });
    }


    clearDashboardCookies(
        res
    );


    return res
        .status(200)
        .json({
            success: true,
            authenticated: false
        });
}
