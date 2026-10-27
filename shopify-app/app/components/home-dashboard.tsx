import { useEffect, useState } from "react";
import { Link } from "react-router";
import styles from "./home-dashboard.module.css";

export interface DashboardData {
  shop: string;
  credits: { available: number; reserved: number };
  trial: {
    active: boolean;
    used: number;
    total: number;
    endsAt: string | null;
  };
  paid: boolean;
  abuseAlert: string | null;
  leadCapture: string;
  leadTiming: string;
  checklist: { products: number; style: boolean; storefront: boolean };
  month: { previews: number; leads: number };
  sales: {
    sales: number;
    currency: string;
    orders: number;
    roas: number | null;
  } | null;
}

type IconName =
  | "box"
  | "credits"
  | "image"
  | "people"
  | "chevron"
  | "check"
  | "warning"
  | "close"
  | "external"
  | "help"
  | "bag"
  | "up";

function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, React.ReactNode> = {
    box: (
      <>
        <path d="m12 3 9 5-9 5-9-5 9-5ZM3 8v10l9 5 9-5V8M12 13v10M7.5 5.5l9 5" />
      </>
    ),
    credits: (
      <>
        <ellipse cx="10" cy="5" rx="7" ry="3" />
        <path d="M3 5v5c0 1.7 3.1 3 7 3m7-8v5M3 10v5c0 1.7 3.1 3 7 3" />
        <ellipse cx="17" cy="14" rx="5" ry="2.5" />
        <path d="M12 14v5c0 1.4 2.2 2.5 5 2.5s5-1.1 5-2.5v-5" />
      </>
    ),
    image: (
      <>
        <rect x="4" y="3" width="16" height="18" rx="2" />
        <circle cx="9" cy="8" r="1" />
        <path d="m4 17 5-5 4 3 3-5 4 6" />
      </>
    ),
    people: (
      <>
        <circle cx="9" cy="7" r="3" />
        <path d="M3 21v-4a6 6 0 0 1 12 0v4H3ZM16 4a3 3 0 0 1 0 6m2 3a5 5 0 0 1 3 5v3h-3" />
      </>
    ),
    chevron: <path d="m9 5 7 7-7 7" />,
    check: <path d="m5 12 4 4L19 6" />,
    warning: (
      <>
        <path d="m10.3 4-8 14a2 2 0 0 0 1.7 3h16a2 2 0 0 0 1.7-3l-8-14a2 2 0 0 0-3.4 0Z" />
        <path d="M12 9v5m0 3v.1" />
      </>
    ),
    close: <path d="m6 6 12 12M6 18 18 6" />,
    external: (
      <>
        <path d="M14 3h7v7m0-7L11 13M10 4H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-5" />
      </>
    ),
    help: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 2-2.5 2-2.5 4m0 4v.1" />
      </>
    ),
    bag: (
      <>
        <path d="m5 7-2 14h18L19 7H5Z" />
        <path d="M9 8V5a3 3 0 0 1 6 0v3" />
      </>
    ),
    up: <path d="m6 15 6-6 6 6" />,
  };
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}

function ActionArt({
  kind,
}: {
  kind: "products" | "fabrics" | "appearance" | "room";
}) {
  return (
    <svg viewBox="0 0 180 76" className={styles.art} aria-hidden="true">
      {kind === "products" ? (
        <>
          <ellipse cx="90" cy="65" rx="29" ry="5" fill="#e4ded6" />
          <path d="m62 25 28-14 29 14-29 15Z" fill="#e1c6a4" />
          <path d="m62 25 28 15v29L62 53Z" fill="#c7a47c" />
          <path d="m90 40 29-15v28L90 69Z" fill="#ac845b" />
          <path d="m77 17 29 15v13l-8 4V36L69 21Z" fill="#f1e5d4" />
          <path d="m71 42 9 5v8l-9-5Z" fill="#e6d5bd" />
        </>
      ) : kind === "fabrics" ? (
        <>
          <path d="m45 34 56-17 33 37-57 17Z" fill="#b7a48c" />
          <path d="m48 28 57-16 33 36-59 18Z" fill="#e4dfd5" />
          <path d="m43 24 58-15 33 34-59 18Z" fill="#989d9c" />
          <path d="m45 18 56-12 30 31-57 18Z" fill="#343551" />
          <path
            d="m50 20 49-11 26 27-49 15Z"
            fill="#4b4c6b"
            stroke="#72738b"
            strokeDasharray="1 2"
          />
          {[0, 1, 2, 3, 4].map((n) => (
            <path
              key={n}
              d={`m${58 + n * 8} ${19 - n * 1.5} 21 24`}
              stroke="#5d5e7a"
              strokeWidth=".6"
            />
          ))}
        </>
      ) : (
        <>
          <rect
            x="31"
            y="5"
            width="118"
            height="65"
            rx="5"
            fill={kind === "room" ? "#e4e5e1" : "#e7e1d8"}
          />
          <path
            d="M31 55h118v10a5 5 0 0 1-5 5H36a5 5 0 0 1-5-5Z"
            fill="#d0c7ba"
          />
          <path d="M43 5v50m90-50v50" stroke="#d4cdc3" />
          {kind === "appearance" ? (
            <>
              <ellipse
                cx="91"
                cy="61"
                rx="47"
                ry="5"
                fill="#b7ab9a"
                opacity=".5"
              />
              <rect
                x="56"
                y="27"
                width="69"
                height="27"
                rx="6"
                fill="#b4a18c"
              />
              <rect
                x="59"
                y="28"
                width="30"
                height="20"
                rx="4"
                fill="#d1c2b0"
              />
              <rect
                x="92"
                y="28"
                width="30"
                height="20"
                rx="4"
                fill="#d9cbbb"
              />
              <rect
                x="51"
                y="44"
                width="79"
                height="15"
                rx="5"
                fill="#c1af99"
              />
              <rect
                x="49"
                y="39"
                width="10"
                height="20"
                rx="4"
                fill="#dbcebd"
              />
              <rect
                x="122"
                y="39"
                width="10"
                height="20"
                rx="4"
                fill="#dbcebd"
              />
              <path d="M57 59v5m68-5v5" stroke="#786956" strokeWidth="3" />
            </>
          ) : (
            <>
              <path d="M57 57V22" stroke="#667254" strokeWidth="2" />
              <path
                d="M57 36Q40 31 45 19q13 3 12 17m0-6Q73 26 68 14q-12 4-11 16m0-6Q47 17 54 10q8 6 3 14m0 20Q72 41 70 30q-11 2-13 14"
                fill="#748365"
              />
              <path d="m49 51 3 13h11l3-13Z" fill="#a38d71" />
              <rect
                x="94"
                y="26"
                width="31"
                height="28"
                rx="6"
                fill="#747c7d"
              />
              <rect
                x="90"
                y="44"
                width="39"
                height="14"
                rx="5"
                fill="#8e9696"
              />
              <path d="M94 58v7m31-7v7" stroke="#575f60" strokeWidth="3" />
            </>
          )}
        </>
      )}
    </svg>
  );
}

export function HomeDashboard({ data: d }: { data: DashboardData }) {
  const [stepsOpen, setStepsOpen] = useState(true);
  const [dismissedTrial, setDismissedTrial] = useState<string | null>(null);
  const [fabricsHref, setFabricsHref] = useState(
    "/app/fabrics?workspace=manual",
  );
  useEffect(() => {
    try {
      const selected = sessionStorage.getItem(
        `tryora:last-fabric-product:${d.shop}`,
      );
      setFabricsHref(
        selected && /^gid:\/\/shopify\/Product\/\d{1,20}$/.test(selected)
          ? `/app/fabrics?product=${encodeURIComponent(selected)}&workspace=manual`
          : "/app/fabrics?workspace=manual",
      );
    } catch {
      /* Navigation still works when browser storage is unavailable. */
    }
  }, [d.shop]);

  const themeEditor = `https://${d.shop}/admin/themes/current/editor?context=apps`;
  const trialKey = `${d.shop}:${d.trial.active}:${d.trial.endsAt}`;
  const daysLeft = d.trial.endsAt
    ? Math.max(
        0,
        Math.ceil(
          (new Date(d.trial.endsAt).getTime() - Date.now()) / 86_400_000,
        ),
      )
    : 0;
  const steps = [
    {
      done: d.checklist.products > 0,
      title: "Choose your products",
      body: "Pick which products shoppers can preview, and which option (like colour) they can switch between.",
      href: "/app/products",
      status:
        d.checklist.products > 0
          ? `${d.checklist.products} set up`
          : "Choose products",
    },
    {
      done: d.checklist.style,
      title: "Pick a style",
      body: "Choose one of five popup styles and how shoppers open it.",
      href: "/app/appearance",
      status: d.checklist.style ? "Style selected" : "Choose style",
    },
    {
      done: d.checklist.storefront,
      title: "Turn Tryora on in your theme",
      body: "Switch on the Tryora app embed in your theme editor so the button appears on product pages.",
      href: themeEditor,
      status: d.checklist.storefront ? "Enabled" : "Open theme editor",
      external: true,
    },
  ];
  const doneCount = steps.filter((step) => step.done).length;
  const metrics: {
    label: string;
    value: number;
    icon: IconName;
    colour: string;
    href?: string;
    note?: string;
  }[] = [
    {
      label: "Configured Products",
      value: d.checklist.products,
      icon: "box",
      colour: "purple",
      href: "/app/products",
    },
    {
      label: "Available Credits",
      value: d.credits.available,
      icon: "credits",
      colour: "green",
      href: "/app/billing",
    },
    {
      label: "AI Previews Generated",
      value: d.month.previews,
      icon: "image",
      colour: "blue",
      note: "This month",
    },
    {
      label: "Leads Captured",
      value: d.month.leads,
      icon: "people",
      colour: "orange",
      href: "/app/leads",
      note: "This month",
    },
  ];
  const actions = [
    {
      title: "Manage Products",
      body: "Choose which products shoppers can preview.",
      href: "/app/products",
      kind: "products" as const,
    },
    {
      title: "Fabrics & Colours",
      body: "Add and manage fabric options.",
      href: fabricsHref,
      kind: "fabrics" as const,
    },
    {
      title: "Appearance",
      body: "Customize the look and style of popups.",
      href: "/app/appearance",
      kind: "appearance" as const,
    },
    {
      title: "Room Assistant",
      body: "Set up room visualization options.",
      href: "/app/assistant",
      kind: "room" as const,
    },
  ];

  return (
    <main className={styles.dashboard}>
      <div className={styles.layout}>
        <div className={styles.main}>
          <header className={styles.header}>
            <div>
              <h1>Welcome to Tryora</h1>
              <p>Create stunning AI product visualizations for your shoppers</p>
            </div>
            <div className={styles.store} title={d.shop}>
              <Icon name="bag" />
              <span>
                {d.shop.replace(/\.myshopify\.com$/, "").replace(/-/g, " ")}
              </span>
            </div>
          </header>

          {d.abuseAlert && (
            <section className={styles.alert} role="status">
              <span className={styles.warningIcon}>
                <Icon name="warning" />
              </span>
              <div>
                <h2>Unusual activity paused some previews</h2>
                <p>
                  On {new Date(d.abuseAlert).toLocaleString("en-GB")} we paused
                  new previews for a few minutes to protect your credits. If
                  this keeps happening, lower your{" "}
                  <Link to="/app/limits">Shopper limits</Link> or contact us.
                </p>
              </div>
            </section>
          )}

          {!d.paid && dismissedTrial !== trialKey && (
            <section className={styles.alert} aria-label="Trial status">
              <span className={styles.warningIcon}>
                <Icon name="warning" />
              </span>
              <div className={styles.alertCopy}>
                <h2>
                  {d.trial.active
                    ? `Free trial: ${Math.max(0, d.trial.total - d.trial.used)} of ${d.trial.total} previews left`
                    : "Your free trial has ended"}
                </h2>
                <p>
                  {d.trial.active
                    ? `Your trial ends in ${daysLeft} days. Trial previews are free and don't renew automatically.`
                    : "Choose a plan to keep showing previews to your shoppers."}
                </p>
              </div>
              <Link className={styles.primaryButton} to="/app/billing">
                See plans
              </Link>
              <button
                className={styles.iconButton}
                aria-label="Dismiss trial notice"
                onClick={() => setDismissedTrial(trialKey)}
              >
                <Icon name="close" />
              </button>
            </section>
          )}

          <section className={styles.metrics} aria-label="Store overview">
            {metrics.map((metric) => {
              const content = (
                <>
                  <span
                    className={`${styles.metricIcon} ${styles[metric.colour]}`}
                  >
                    <Icon name={metric.icon} />
                  </span>
                  <div className={styles.metricCopy}>
                    <span className={styles.metricLabel}>{metric.label}</span>
                    <strong>{metric.value.toLocaleString("en-GB")}</strong>
                    {metric.note && <small>{metric.note}</small>}
                  </div>
                  {metric.href && (
                    <span className={styles.metricArrow}>
                      <Icon name="chevron" />
                    </span>
                  )}
                </>
              );
              return metric.href ? (
                <Link
                  key={metric.label}
                  to={metric.href}
                  className={styles.metric}
                >
                  {content}
                </Link>
              ) : (
                <div key={metric.label} className={styles.metric}>
                  {content}
                </div>
              );
            })}
          </section>

          <section
            className={styles.panel}
            aria-labelledby="quick-actions-title"
          >
            <h2 id="quick-actions-title">Quick actions</h2>
            <p className={styles.subtitle}>
              Jump to the most important settings for your Tryora experience.
            </p>
            <div className={styles.actions}>
              {actions.map((action) => (
                <Link
                  key={action.kind}
                  to={action.href}
                  className={styles.action}
                >
                  <ActionArt kind={action.kind} />
                  <div className={styles.actionCopy}>
                    <h3>{action.title}</h3>
                    <p>{action.body}</p>
                    <span>
                      <Icon name="chevron" />
                    </span>
                  </div>
                </Link>
              ))}
            </div>
          </section>

          <section className={styles.panel} aria-labelledby="setup-title">
            <div className={styles.setupHeader}>
              <div>
                <h2 id="setup-title" className={styles.setupTitle}>
                  Get set up ({doneCount} of 3)
                </h2>
                <p className={styles.subtitle}>
                  {doneCount === 3
                    ? "You've completed all the essential steps. You can update these anytime."
                    : "Complete these essential steps to get Tryora ready for your shoppers."}
                </p>
              </div>
              <button
                className={styles.button}
                aria-expanded={stepsOpen}
                aria-controls="tryora-setup-steps"
                onClick={() => setStepsOpen(!stepsOpen)}
              >
                {stepsOpen ? "Hide steps" : "Show steps"}
                <span className={!stepsOpen ? styles.rotate : undefined}>
                  <Icon name="up" />
                </span>
              </button>
            </div>
            <div
              id="tryora-setup-steps"
              className={styles.steps}
              hidden={!stepsOpen}
            >
              {steps.map((step, index) => {
                const content = (
                  <>
                    <span
                      className={`${styles.stepIcon} ${step.done ? styles.complete : ""}`}
                    >
                      {step.done ? <Icon name="check" /> : index + 1}
                    </span>
                    <div className={styles.stepCopy}>
                      <h3>
                        {step.title}
                        <span className={styles.srOnly}>
                          {step.done ? ", completed" : ", incomplete"}
                        </span>
                      </h3>
                      <p>{step.body}</p>
                    </div>
                    <span className={styles.stepStatus}>{step.status}</span>
                    <Icon name="chevron" />
                  </>
                );
                return step.external ? (
                  <a
                    key={step.title}
                    href={step.href}
                    target="_blank"
                    rel="noreferrer"
                    className={styles.step}
                  >
                    {content}
                  </a>
                ) : (
                  <Link key={step.title} to={step.href} className={styles.step}>
                    {content}
                  </Link>
                );
              })}
            </div>
          </section>

          {d.sales && (
            <section className={styles.panel} aria-labelledby="sales-title">
              <h2 id="sales-title">Sales from Tryora – last 30 days</h2>
              <div className={styles.sales}>
                <div>
                  <span>Sales</span>
                  <strong>
                    {new Intl.NumberFormat("en-GB", {
                      style: "currency",
                      currency: d.sales.currency,
                      maximumFractionDigits: 0,
                    }).format(d.sales.sales)}
                  </strong>
                </div>
                <div>
                  <span>Orders</span>
                  <strong>{d.sales.orders}</strong>
                </div>
                <div>
                  <span>Return on Tryora</span>
                  <strong>
                    {d.sales.roas === null ? "–" : `${d.sales.roas}×`}
                  </strong>
                </div>
              </div>
              <p className={styles.subtitle}>
                Orders where the shopper saw the product in their own room
                before buying, counting only those products. Compared with what
                you paid for Tryora over the same 30 days.
              </p>
            </section>
          )}
        </div>

        <aside className={styles.aside} aria-label="Account and help">
          <section className={styles.sidePanel}>
            <h2>
              <span className={styles.blueText}>
                <Icon name="credits" />
              </span>
              Credits &amp; usage
            </h2>
            <p>
              One credit is used only when a shopper actually receives their
              preview. Rejected photos, failed images and confirmed problems
              don&apos;t cost you anything.
            </p>
            <div className={styles.creditDivider}>
              <div className={styles.balance}>
                <div>
                  <span>Available credits</span>
                  <strong>{d.credits.available.toLocaleString("en-GB")}</strong>
                </div>
                <Link className={styles.button} to="/app/billing">
                  See plans
                  <Icon name="chevron" />
                </Link>
              </div>
            </div>
          </section>
          <section className={styles.sidePanel}>
            <h2>
              <span className={styles.blueText}>
                <Icon name="people" />
              </span>
              Lead capture
            </h2>
            <p>
              Shoppers&apos; email:{" "}
              {d.leadCapture === "off"
                ? "Not asked."
                : `${d.leadCapture === "required" ? "Required" : "Optional"}, ${d.leadTiming === "after" ? "after" : "before"} the first image.`}
            </p>
            <Link to="/app/leads" className={styles.change}>
              Change
              <Icon name="chevron" />
            </Link>
          </section>
          <section className={styles.sidePanel}>
            <h2>
              <span className={styles.helpIcon}>
                <Icon name="help" />
              </span>
              Need help?
            </h2>
            <p>
              If you need any help setting up Tryora or have questions, we&apos;re
              here for you.
            </p>
            <a
              className={styles.button}
              href="mailto:support@visully.io?subject=Tryora%20Support%20Request"
              target="_top"
            >
              Contact support
              <Icon name="external" />
            </a>
          </section>
        </aside>
      </div>
    </main>
  );
}
