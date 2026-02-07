import { Link } from 'react-router-dom';
import './Nav.css';

const Nav = () => {
  return (
    <>
      <nav>
        <ul>
          <li>
            <Link to="/import">Tweet Knowledge Explorer</Link>
          </li>
        </ul>
      </nav>
      {/* <SubNav /> */}
    </>
  );
};
export default Nav;
